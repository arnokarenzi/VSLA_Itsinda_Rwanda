"use strict";

const db = require("../config/db");
const { insertLedgerEntry } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { parseSettings } = require("./constitutionRules");
const { calculateGusibuzaFee } = require("./gusibuzaHelpers");

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a valid positive integer.`);
  return parsed;
}
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }

async function listEligibleGusibuzaMeetings(groupId, cycleId, currentMeetingId, memberId) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const currentId = positiveId(currentMeetingId, "Current meeting ID");
  const mid = positiveId(memberId, "Member ID");
  const [contextRows] = await db.query(
    `SELECT m.meeting_number AS current_meeting_number, m.status AS current_meeting_status,
        c.status AS cycle_status, g.settings
     FROM meetings m JOIN cycles c ON c.id = m.cycle_id AND c.group_id = m.group_id
     JOIN \`groups\` g ON g.id = m.group_id
     WHERE m.id = ? AND m.group_id = ? AND m.cycle_id = ? LIMIT 1`,
    [currentId, gid, cid],
  );
  if (!contextRows.length || contextRows[0].current_meeting_status !== "OPEN" || contextRows[0].cycle_status !== "ACTIVE") {
    throw new Error("Select the group's open meeting in its active cycle before recording gusibuza.");
  }
  const settings = parseSettings(contextRows[0].settings);
  const feeMode = String(settings.gusibuzaFeeMode || "PER_SHARE").toUpperCase();
  const feeAmount = Number(settings.gusibuzaFeeAmount || 0);
  if (settings.gusibuzaEnabled !== true) return { enabled: false, meetings: [], feeMode, feeAmount };
  const maxShares = settings.maxSharesPerMeeting == null || settings.maxSharesPerMeeting === "" ? null : Number(settings.maxSharesPerMeeting);
  if (!Number.isSafeInteger(maxShares) || maxShares <= 0) {
    return { enabled: true, meetings: [], feeMode, feeAmount, message: "Gusibuza requires a defined maximum shares-per-meeting rule." };
  }
  const [memberRows] = await db.query(
    "SELECT id FROM users WHERE id = ? AND group_id = ? AND COALESCE(is_active, 1) = 1 LIMIT 1", [mid, gid],
  );
  if (!memberRows.length) throw new Error("The selected member is not active in this group.");
  const [attendanceRows] = await db.query(
    `SELECT attendance_status FROM meeting_attendance WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND member_id = ? LIMIT 1`,
    [gid, cid, currentId, mid],
  );
  if (String(attendanceRows[0]?.attendance_status || "").toUpperCase() !== "PRESENT") {
    throw new Error("Only a member marked Present may use gusibuza during this meeting.");
  }
  const [rows] = await db.query(
    `SELECT m.id, m.meeting_number, m.date,
        COALESCE(SUM(CASE WHEN t.type = 'SHARE_PURCHASE' AND t.status = 'POSTED' THEN t.shares_count ELSE 0 END), 0) AS shares_paid,
        EXISTS(SELECT 1 FROM transactions fee WHERE fee.group_id = ? AND fee.cycle_id = ? AND fee.member_id = ?
          AND fee.credited_meeting_id = m.id AND fee.type = 'GUSIBUZA_FEE' AND fee.status = 'POSTED') AS meeting_fee_paid
     FROM meetings m
     LEFT JOIN transactions t ON t.group_id = m.group_id AND t.cycle_id = m.cycle_id AND t.member_id = ?
       AND t.type = 'SHARE_PURCHASE' AND COALESCE(t.credited_meeting_id, t.meeting_id) = m.id AND t.status = 'POSTED'
     WHERE m.group_id = ? AND m.cycle_id = ? AND m.status = 'CLOSED' AND m.meeting_number < ?
     GROUP BY m.id, m.meeting_number, m.date
     HAVING COALESCE(SUM(CASE WHEN t.type = 'SHARE_PURCHASE' AND t.status = 'POSTED' THEN t.shares_count ELSE 0 END), 0) < ?
     ORDER BY m.meeting_number ASC, m.id ASC`,
    [gid, cid, mid, mid, gid, cid, Number(contextRows[0].current_meeting_number), maxShares],
  );
  return {
    enabled: true, feeMode, feeAmount, shareValue: Number(settings.shareValue), maxSharesPerMeeting: maxShares,
    meetings: rows.map((row) => ({ meetingId: Number(row.id), meetingNumber: Number(row.meeting_number), date: row.date,
      sharesPaid: Number(row.shares_paid || 0), sharesRemaining: Math.max(0, maxShares - Number(row.shares_paid || 0)),
      feeAlreadyPaid: Boolean(Number(row.meeting_fee_paid)) })),
  };
}

async function recordGusibuza({ groupId, cycleId, currentMeetingId, memberId, targetMeetingId, sharesCount, createdBy, auditMeta = {} }) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const currentId = positiveId(currentMeetingId, "Current meeting ID");
  const mid = positiveId(memberId, "Member ID");
  const targetId = positiveId(targetMeetingId, "Target meeting ID");
  const actorId = positiveId(createdBy, "Recording user ID");
  const shares = Number(sharesCount);
  if (!Number.isSafeInteger(shares) || shares <= 0) throw new Error("Choose a positive whole number of late shares.");
  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [cycleRows] = await connection.query(`SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`, [cid, gid]);
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    const [currentRows] = await connection.query(`SELECT id, meeting_number FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'OPEN' FOR UPDATE`, [currentId, gid, cid]);
    if (!currentRows.length) throw new Error("Gusibuza must be recorded in the currently open meeting.");
    const [targetRows] = await connection.query(`SELECT id, meeting_number FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'CLOSED' FOR UPDATE`, [targetId, gid, cid]);
    if (!targetRows.length) throw new Error("Choose a previously closed meeting in the same cycle for the late shares.");
    const currentNumber = Number(currentRows[0].meeting_number);
    const targetNumber = Number(targetRows[0].meeting_number);
    if (targetNumber >= currentNumber) throw new Error("Gusibuza shares can only be credited to an earlier meeting.");
    const [memberRows] = await connection.query(`SELECT id FROM users WHERE id = ? AND group_id = ? AND COALESCE(is_active, 1) = 1 FOR UPDATE`, [mid, gid]);
    if (!memberRows.length) throw new Error("The selected member is not active in this group.");
    const [attendanceRows] = await connection.query(`SELECT attendance_status FROM meeting_attendance WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND member_id = ? LIMIT 1 FOR UPDATE`, [gid, cid, currentId, mid]);
    if (String(attendanceRows[0]?.attendance_status || "").toUpperCase() !== "PRESENT") throw new Error("Only a member marked Present may use gusibuza during this meeting.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw new Error("Group not found.");
    const settings = parseSettings(groupRows[0].settings);
    if (settings.gusibuzaEnabled !== true) throw new Error("Gusibuza is not enabled in the approved group constitution.");
    const feeMode = String(settings.gusibuzaFeeMode || "PER_SHARE").toUpperCase();
    const feeAmount = Number(settings.gusibuzaFeeAmount || 0);
    const shareValue = Number(settings.shareValue);
    const maxShares = Number(settings.maxSharesPerMeeting);
    if (!Number.isFinite(shareValue) || shareValue <= 0 || !Number.isSafeInteger(maxShares) || maxShares <= 0 || !Number.isFinite(feeAmount) || feeAmount <= 0) throw new Error("The approved gusibuza share, maximum-share, or fee settings are invalid.");

    const [currentContributionRows] = await connection.query(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'SHARE_PURCHASE' AND t.status = 'POSTED' THEN t.shares_count ELSE 0 END), 0) AS shares_count,
          COALESCE(SUM(CASE WHEN t.type = 'SOCIAL_FUND' AND t.status = 'POSTED' THEN t.amount ELSE 0 END), 0) AS social_fund_paid
       FROM transactions t WHERE t.group_id = ? AND t.cycle_id = ? AND t.member_id = ? AND t.meeting_id = ? AND COALESCE(t.credited_meeting_id, t.meeting_id) = ?`,
      [gid, cid, mid, currentId, currentId],
    );
    const currentShares = Number(currentContributionRows[0]?.shares_count || 0);
    const minShares = Number(settings.minSharesPerMeeting ?? 1);
    if (currentShares < minShares) throw new Error(`Record this member's regular shares for Meeting #${currentNumber} first; the minimum is ${minShares}. Gusibuza shares are credited to the earlier meeting.`);
    if (String(settings.socialFundMode || "FLEXIBLE").toUpperCase() === "FIXED") {
      const requiredSocial = Number(settings.socialFundContributionAmount);
      const socialPaid = roundMoney(currentContributionRows[0]?.social_fund_paid || 0);
      if (Math.abs(socialPaid - requiredSocial) > 0.009) throw new Error(`Record the exact ${requiredSocial.toLocaleString()} RWF Social Fund contribution for the current meeting before recording gusibuza.`);
    }
    const [targetShareRows] = await connection.query(
      `SELECT COALESCE(SUM(shares_count), 0) AS shares_paid FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND type = 'SHARE_PURCHASE' AND COALESCE(credited_meeting_id, meeting_id) = ? AND status = 'POSTED'`,
      [gid, cid, mid, targetId],
    );
    const alreadyPaidShares = Number(targetShareRows[0]?.shares_paid || 0);
    const gap = Math.max(0, maxShares - alreadyPaidShares);
    if (shares > gap) throw new Error(`Meeting #${targetNumber} has room for only ${gap} more share(s); the maximum is ${maxShares}.`);
    const [feeRows] = await connection.query(
      `SELECT id FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND credited_meeting_id = ? AND type = 'GUSIBUZA_FEE' AND status = 'POSTED' LIMIT 1 FOR UPDATE`,
      [gid, cid, mid, targetId],
    );
    const fee = calculateGusibuzaFee({ feeMode, feeAmount, sharesCount: shares, alreadyPaidPerMeetingFee: feeRows.length > 0 });
    const shareTotal = roundMoney(shares * shareValue);
    const [shareResult] = await connection.query(
      `INSERT INTO transactions (group_id, cycle_id, meeting_id, credited_meeting_id, member_id, type, amount, shares_count, fine_reason)
       VALUES (?, ?, ?, ?, ?, 'SHARE_PURCHASE', ?, ?, ?)`,
      [gid, cid, currentId, targetId, mid, shareTotal, shares, `Gusibuza: credited to Meeting #${targetNumber}`],
    );
    const shareLedgerId = await insertLedgerEntry(connection, { groupId: gid, cycleId: cid, meetingId: currentId, memberId: mid,
      fundType: "LOAN_FUND", entryType: "SHARE_PURCHASE", direction: "IN", amount: shareTotal, profitEffect: 0,
      notes: `Gusibuza: ${shares} share(s) credited to Meeting #${targetNumber}.`, sourceType: "TRANSACTION", sourceId: shareResult.insertId,
      sourceComponent: "TOTAL", createdBy: actorId });
    const shareReceipt = await createReceipt(connection, { groupId: gid, cycleId: cid, meetingId: currentId, memberId: mid,
      sourceType: "TRANSACTION", sourceId: shareResult.insertId, sourceComponent: "TOTAL", activityType: "GUSIBUZA_SHARE_PURCHASE",
      amount: shareTotal, summary: `${shares} late share(s) credited to Meeting #${targetNumber}`,
      details: { transactionId: shareResult.insertId, ledgerEntryId: shareLedgerId, sharesCount: shares, creditedMeetingId: targetId, creditedMeetingNumber: targetNumber, paidInMeetingId: currentId }, issuedBy: actorId });

    let feeTransactionId = null;
    let feeReceipt = null;
    if (fee > 0) {
      const [feeResult] = await connection.query(
        `INSERT INTO transactions (group_id, cycle_id, meeting_id, credited_meeting_id, member_id, type, amount, shares_count, fine_reason)
         VALUES (?, ?, ?, ?, ?, 'GUSIBUZA_FEE', ?, 0, ?)`,
        [gid, cid, currentId, targetId, mid, fee, `Gusibuza fee for Meeting #${targetNumber}`],
      );
      feeTransactionId = Number(feeResult.insertId);
      const feeLedgerId = await insertLedgerEntry(connection, { groupId: gid, cycleId: cid, meetingId: currentId, memberId: mid,
        fundType: "LOAN_FUND", entryType: "GUSIBUZA_FEE", direction: "IN", amount: fee, profitEffect: fee,
        notes: `Gusibuza fee for late shares credited to Meeting #${targetNumber}.`, sourceType: "TRANSACTION", sourceId: feeTransactionId,
        sourceComponent: "TOTAL", createdBy: actorId });
      feeReceipt = await createReceipt(connection, { groupId: gid, cycleId: cid, meetingId: currentId, memberId: mid,
        sourceType: "TRANSACTION", sourceId: feeTransactionId, sourceComponent: "TOTAL", activityType: "GUSIBUZA_FEE", amount: fee,
        summary: `Gusibuza fee for Meeting #${targetNumber}`,
        details: { transactionId: feeTransactionId, ledgerEntryId: feeLedgerId, creditedMeetingId: targetId, creditedMeetingNumber: targetNumber, feeMode, feeAmount }, issuedBy: actorId });
    }
    await writeAuditEvent(connection, { groupId: gid, cycleId: cid, meetingId: currentId, actorUserId: actorId,
      action: "GUSIBUZA_RECORDED", entityType: "SHARE_PURCHASE", entityId: shareResult.insertId,
      afterData: { memberId: mid, creditedMeetingId: targetId, creditedMeetingNumber: targetNumber, sharesCount: shares, shareTotal,
        feeMode, fee, feeTransactionId, shareReceiptNumber: shareReceipt.receiptNumber, feeReceiptNumber: feeReceipt?.receiptNumber || null },
      reason: `Late share purchase for Meeting #${targetNumber}.`, ...auditMeta });
    await connection.commit();
    transactionStarted = false;
    return { targetMeetingId: targetId, targetMeetingNumber: targetNumber, sharesCount: shares, shareTotal, feeMode, fee,
      remainingShares: Math.max(0, gap - shares), shareReceipt, feeReceipt };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    throw new Error(`Gusibuza failed: ${error.message}`, { cause: error });
  } finally {
    connection.release();
  }
}

module.exports = { listEligibleGusibuzaMeetings, recordGusibuza };
