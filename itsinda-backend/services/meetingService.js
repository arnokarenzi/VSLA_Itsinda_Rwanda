const db = require("../config/db");
const { insertLedgerEntry } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { validateMeetingContributions, validateFixedSocialFundMeetingClosure, validateMeetingAttendanceForClosure, resolveFineAssessment, parseSettings } = require("./constitutionRules");
const { findAutomaticAbsenceFineRule, isAutomaticAbsenceFineLabel } = require("./gusibuzaHelpers");

async function openMeeting(groupId, cycleId, meetingNumber, date, createdBy, auditMeta = {}) {
  const parsedGroupId = Number(groupId);
  const parsedCycleId = Number(cycleId);
  const parsedMeetingNumber = Number(meetingNumber);
  if (!Number.isSafeInteger(parsedGroupId) || parsedGroupId <= 0 ||
      !Number.isSafeInteger(parsedCycleId) || parsedCycleId <= 0 ||
      !Number.isSafeInteger(parsedMeetingNumber) || parsedMeetingNumber <= 0) {
    throw new Error("Group, active cycle, and meeting number must be valid positive integers.");
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    // Locking the cycle above serializes open-meeting attempts. Only one meeting may be open.
    const [openMeetings] = await connection.query(
      `SELECT id, meeting_number FROM meetings
       WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN'
       ORDER BY meeting_number DESC, id DESC LIMIT 1 FOR UPDATE`,
      [parsedGroupId, parsedCycleId],
    );
    if (openMeetings.length) {
      throw new Error(`Meeting #${openMeetings[0].meeting_number} is still open. Resume and close it before opening another meeting.`);
    }
    const [duplicates] = await connection.query(
      `SELECT id FROM meetings WHERE group_id = ? AND cycle_id = ? AND meeting_number = ? LIMIT 1`,
      [parsedGroupId, parsedCycleId, parsedMeetingNumber],
    );
    if (duplicates.length) throw new Error(`Meeting #${parsedMeetingNumber} already exists in this cycle.`);

    const [result] = await connection.query(
      `INSERT INTO meetings (group_id, cycle_id, meeting_number, date, status)
       VALUES (?, ?, ?, ?, 'OPEN')`,
      [parsedGroupId, parsedCycleId, parsedMeetingNumber, date || new Date()],
    );
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: result.insertId,
      actorUserId: createdBy, action: "MEETING_OPENED", entityType: "MEETING", entityId: result.insertId,
      afterData: { meetingNumber: parsedMeetingNumber, date: date || new Date(), status: "OPEN" }, ...auditMeta,
    });
    await connection.commit();
    return { id: result.insertId, meetingId: result.insertId, groupId: parsedGroupId, cycleId: parsedCycleId, meetingNumber: parsedMeetingNumber, status: "OPEN" };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}


async function requireCurrentBalancedCashCount(connection, groupId, cycleId, meetingId, fundType) {
  const label = fundType === "LOAN_FUND" ? "Loan Fund" : "Social Fund";
  const [ledgerRows] = await connection.query(
    `SELECT MAX(id) AS last_entry_id FROM fund_ledger_entries
     WHERE group_id = ? AND cycle_id = ? AND fund_type = ?`,
    [groupId, cycleId, fundType],
  );
  const lastEntryId = ledgerRows[0]?.last_entry_id == null ? null : Number(ledgerRows[0].last_entry_id);
  const [reconciliations] = await connection.query(
    `SELECT variance, ledger_entry_id_at_count, meeting_id, witness_member_id FROM cash_reconciliations
     WHERE group_id = ? AND cycle_id = ? AND fund_type = ?
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [groupId, cycleId, fundType],
  );
  if (!reconciliations.length) {
    throw new Error(`Before closing the meeting, record a physical cash count for the ${label} in Cashbook & Reconciliation.`);
  }
  const reconciliation = reconciliations[0];
  if (reconciliation.meeting_id == null || Number(reconciliation.meeting_id) !== meetingId) {
    throw new Error(`Record the ${label} physical cash count while this meeting is selected in Cashbook & Reconciliation before closing the meeting.`);
  }
  if (!reconciliation.witness_member_id) {
    throw new Error(`${label} count has no recorded witness. Record a new count with a member marked Present in this meeting.`);
  }
  const [witnessAttendanceRows] = await connection.query(
    `SELECT 1 FROM meeting_attendance
     WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND member_id = ? AND attendance_status = 'PRESENT'
     LIMIT 1 FOR UPDATE`,
    [groupId, cycleId, meetingId, Number(reconciliation.witness_member_id)],
  );
  if (!witnessAttendanceRows.length) {
    throw new Error(`${label} witness is not marked Present in this meeting's attendance register. Choose a present witness and record the cash count again.`);
  }
  const countEntryId = reconciliation.ledger_entry_id_at_count == null ? null : Number(reconciliation.ledger_entry_id_at_count);
  if (countEntryId !== lastEntryId) {
    throw new Error(`${label} has ledger entries recorded after its latest physical count. Recount and reconcile it before closing the meeting.`);
  }
  const variance = Number(reconciliation.variance || 0);
  if (!Number.isFinite(variance) || Math.abs(variance) >= 0.01) {
    throw new Error(`${label} has an unresolved cash-count difference of ${variance.toLocaleString()} RWF. Investigate and reconcile it before closing the meeting.`);
  }
}

async function closeMeeting(groupId, cycleId, meetingId, createdBy, auditMeta = {}) {
  const parsedGroupId = Number(groupId);
  const parsedCycleId = Number(cycleId);
  const parsedMeetingId = Number(meetingId);
  if (![parsedGroupId, parsedCycleId, parsedMeetingId].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Group, active cycle and meeting IDs must be valid positive integers.");
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'OPEN' FOR UPDATE`,
      [parsedMeetingId, parsedGroupId, parsedCycleId],
    );
    if (!meetingRows.length) throw new Error("This meeting is not open for the selected group and cycle.");
    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? LIMIT 1", [parsedGroupId]);
    if (!groupRows.length) throw new Error("Group not found.");
    const groupSettings = parseSettings(groupRows[0].settings);
    const [memberAttendanceRows] = await connection.query(
      `SELECT u.id AS member_id, u.full_name,
          COALESCE(ma.attendance_status, 'NOT_RECORDED') AS attendance_status,
          COALESCE(ma.notes, '') AS attendance_notes,
          COALESCE(SUM(CASE WHEN t.type = 'SOCIAL_FUND' AND t.status = 'POSTED' THEN t.amount ELSE 0 END), 0) AS social_fund_paid
       FROM users u
       LEFT JOIN meeting_attendance ma ON ma.group_id = u.group_id AND ma.cycle_id = ? AND ma.meeting_id = ? AND ma.member_id = u.id
       LEFT JOIN transactions t ON t.group_id = u.group_id AND t.cycle_id = ? AND t.meeting_id = ? AND t.member_id = u.id
       WHERE u.group_id = ? AND COALESCE(u.is_active, 1) = 1
       GROUP BY u.id, u.full_name, ma.attendance_status, ma.notes
       ORDER BY u.full_name ASC`,
      [parsedCycleId, parsedMeetingId, parsedCycleId, parsedMeetingId, parsedGroupId],
    );
    validateMeetingAttendanceForClosure(memberAttendanceRows);
    validateFixedSocialFundMeetingClosure(groupSettings, memberAttendanceRows);

    // Assess the constitution-defined absence fine automatically at close. This is a debt
    // assessment only; it does not create a cash ledger entry until the fine is paid.
    const absentMembers = memberAttendanceRows.filter((row) => String(row.attendance_status).toUpperCase() === "ABSENT");
    if (absentMembers.length) {
      const absenceRule = findAutomaticAbsenceFineRule(groupSettings.fineRules);
      const absenceFineAmount = Number(absenceRule?.amount);
      if (!absenceRule || !Number.isFinite(absenceFineAmount) || absenceFineAmount <= 0) {
        throw new Error('The group has absent members but no valid "Absence without excuse" fine is defined in the approved constitution. Add this rule before closing the meeting.');
      }
      const [existingAutoFineRows] = await connection.query(
        `SELECT member_id, fine_label FROM fine_assessments
         WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND status <> 'REVERSED'`,
        [parsedGroupId, parsedCycleId, parsedMeetingId],
      );
      const alreadyAssessed = new Set(existingAutoFineRows
        .filter((row) => isAutomaticAbsenceFineLabel(row.fine_label))
        .map((row) => Number(row.member_id)));
      for (const absent of absentMembers) {
        if (alreadyAssessed.has(Number(absent.member_id))) continue;
        const [fineResult] = await connection.query(
          `INSERT INTO fine_assessments
            (group_id, cycle_id, meeting_id, member_id, fine_label, reason, amount, amount_paid, status, assessed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'OUTSTANDING', ?)`,
          [parsedGroupId, parsedCycleId, parsedMeetingId, Number(absent.member_id),
            String(absenceRule.label || absenceRule.name).trim(), "Absent without excuse", Math.round((absenceFineAmount + Number.EPSILON) * 100) / 100, createdBy],
        );
        await writeAuditEvent(connection, {
          groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
          actorUserId: createdBy, action: "ABSENCE_FINE_ASSESSED_ON_MEETING_CLOSE", entityType: "FINE_ASSESSMENT", entityId: fineResult.insertId,
          afterData: { memberId: Number(absent.member_id), fineLabel: String(absenceRule.label || absenceRule.name).trim(), reason: "Absent without excuse", amount: Math.round((absenceFineAmount + Number.EPSILON) * 100) / 100, amountPaid: 0, status: "OUTSTANDING" },
          reason: "Automatically assessed because the member was marked Absent in the saved attendance register.", ...auditMeta,
        });
      }
    }
    await requireCurrentBalancedCashCount(connection, parsedGroupId, parsedCycleId, parsedMeetingId, "LOAN_FUND");
    await requireCurrentBalancedCashCount(connection, parsedGroupId, parsedCycleId, parsedMeetingId, "SOCIAL_FUND");

    // Read back the persisted meeting records inside the same transaction. The counts
    // are stored in the close audit event and returned after commit as a save receipt.
    const [persistedRows] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM transactions WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS transaction_count,
        (SELECT COUNT(*) FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS ledger_entry_count,
        (SELECT COUNT(*) FROM financial_receipts WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS receipt_count,
        (SELECT COUNT(*) FROM fine_assessments WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND status <> 'REVERSED') AS fine_assessment_count,
        (SELECT COUNT(*) FROM meeting_attendance WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS attendance_count,
        (SELECT COUNT(*) FROM meeting_records WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS meeting_record_count,
        (SELECT COUNT(*) FROM cash_reconciliations WHERE group_id = ? AND cycle_id = ? AND meeting_id = ?) AS cash_reconciliation_count,
        (SELECT COUNT(DISTINCT loan_id) FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND entry_type = 'LOAN_DISBURSEMENT' AND loan_id IS NOT NULL) AS loan_disbursement_count,
        (SELECT COUNT(*) FROM transactions WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND type = 'LOAN_REPAYMENT' AND status = 'POSTED') AS loan_repayment_count`,
      [parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId,
        parsedGroupId, parsedCycleId, parsedMeetingId],
    );
    const persistedRecords = {
      transactions: Number(persistedRows[0].transaction_count || 0),
      cashbookEntries: Number(persistedRows[0].ledger_entry_count || 0),
      receipts: Number(persistedRows[0].receipt_count || 0),
      fineAssessments: Number(persistedRows[0].fine_assessment_count || 0),
      attendanceRows: Number(persistedRows[0].attendance_count || 0),
      meetingNotes: Number(persistedRows[0].meeting_record_count || 0),
      cashReconciliations: Number(persistedRows[0].cash_reconciliation_count || 0),
      loansDisbursed: Number(persistedRows[0].loan_disbursement_count || 0),
      loanRepayments: Number(persistedRows[0].loan_repayment_count || 0),
    };
    if (persistedRecords.meetingNotes < 1) {
      throw new Error("Save the meeting notes and attendance register before closing. Nothing was closed; the meeting remains open.");
    }
    await connection.query(
      `UPDATE meetings SET status = 'CLOSED' WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'OPEN'`,
      [parsedMeetingId, parsedGroupId, parsedCycleId],
    );
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: createdBy, action: "MEETING_CLOSED", entityType: "MEETING", entityId: parsedMeetingId,
      beforeData: { meetingNumber: Number(meetingRows[0].meeting_number), status: "OPEN" },
      afterData: { meetingNumber: Number(meetingRows[0].meeting_number), status: "CLOSED", persistedRecords }, ...auditMeta,
    });
    await connection.commit();
    return { id: parsedMeetingId, groupId: parsedGroupId, cycleId: parsedCycleId,
      meetingNumber: Number(meetingRows[0].meeting_number), status: "CLOSED", persistedRecords };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}


/** Record share purchases, fines and social-fund contributions atomically in both records and cashbook. */
async function recordMeetingTransactions(groupId, cycleId, meetingId, memberId, transactionsData, createdBy, auditMeta = {}, fineAssessment = null) {
  const parsedGroupId = Number(groupId);
  const parsedCycleId = Number(cycleId);
  const parsedMeetingId = Number(meetingId);
  const parsedMemberId = Number(memberId);
  const parsedCreatedBy = Number(createdBy);
  if (![parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, parsedCreatedBy].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Group, cycle, meeting, member and recording-user IDs must be valid positive integers.");
  }
  if (!Array.isArray(transactionsData) || (transactionsData.length === 0 && !fineAssessment)) {
    throw new Error("Record a contribution or select a fine rule before submitting.");
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected cycle is not active for this group.");
    const [meetingRows] = await connection.query(
      `SELECT id FROM meetings WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'OPEN' FOR UPDATE`,
      [parsedMeetingId, parsedGroupId, parsedCycleId],
    );
    if (!meetingRows.length) throw new Error("The meeting is not open for this group and active cycle.");
    const [memberRows] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1`,
      [parsedMemberId, parsedGroupId],
    );
    if (!memberRows.length) throw new Error("The selected member is not active in this group.");

    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ?", [parsedGroupId]);
    if (!groupRows.length) throw new Error("Group not found.");
    let settings = groupRows[0].settings;
    if (typeof settings === "string") {
      try { settings = JSON.parse(settings); } catch { throw new Error("Group settings contain invalid JSON."); }
    }
    const shareValue = Number(settings?.shareValue);
    if (!Number.isFinite(shareValue) || shareValue <= 0) throw new Error("The group's share value setting is invalid.");

    // Validate constitution-approved limits before writing any transaction/ledger rows.
    // Current-cycle counters are read inside the same DB transaction as the writes.
    const sharePurchases = transactionsData.filter((tx) => String(tx?.type || "").toUpperCase() === "SHARE_PURCHASE");
    const socialFundTransactions = transactionsData.filter((tx) => String(tx?.type || "").toUpperCase() === "SOCIAL_FUND");
    const fineTransactions = transactionsData.filter((tx) => String(tx?.type || "").toUpperCase() === "FINE_PAYMENT");
    let sharesAlreadyPurchasedThisMeeting = 0;
    let socialFundAlreadyPaidThisMeeting = 0;
    if (sharePurchases.length || socialFundTransactions.length) {
      const [meetingShareRows] = await connection.query(
        `SELECT COALESCE(SUM(shares_count), 0) AS shares_count
         FROM transactions WHERE group_id = ? AND cycle_id = ? AND COALESCE(credited_meeting_id, meeting_id) = ? AND member_id = ?
           AND type = 'SHARE_PURCHASE' AND status = 'POSTED'`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId],
      );
      sharesAlreadyPurchasedThisMeeting = Number(meetingShareRows[0]?.shares_count || 0);
    }
    if (socialFundTransactions.length || (String(settings?.socialFundMode || "FLEXIBLE").toUpperCase() === "FIXED" && (sharePurchases.length > 0 || transactionsData.length > 0 || Boolean(fineAssessment)))) {
      const [socialRows] = await connection.query(
        `SELECT COALESCE(SUM(amount), 0) AS amount
         FROM transactions WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND member_id = ?
           AND type = 'SOCIAL_FUND' AND status = 'POSTED'`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId],
      );
      socialFundAlreadyPaidThisMeeting = Number(socialRows[0]?.amount || 0);
    }
    let attendanceStatus = null;
    const hasContributionActivity = transactionsData.length > 0 || Boolean(fineAssessment);
    if (hasContributionActivity) {
      const [attendanceRows] = await connection.query(
        `SELECT attendance_status FROM meeting_attendance
         WHERE group_id = ? AND cycle_id = ? AND meeting_id = ? AND member_id = ? LIMIT 1 FOR UPDATE`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId],
      );
      attendanceStatus = String(attendanceRows[0]?.attendance_status || "").toUpperCase();
      if (attendanceStatus !== "PRESENT") {
        throw new Error("Only members marked Present may be selected for Meeting Operations & Contributions. Absent fines are assessed automatically when the meeting closes; excused members are exempt.");
      }
    }

    validateMeetingContributions({
      terms: settings,
      existingSharesThisMeeting: sharesAlreadyPurchasedThisMeeting,
      sharePurchases,
      existingSocialFundAmount: socialFundAlreadyPaidThisMeeting,
      socialFundTransactions,
      fineTransactions,
      attendanceStatus,
      hasFineAssessment: Boolean(fineAssessment),
    });

    const resolvedFine = fineAssessment ? resolveFineAssessment(settings, fineAssessment) : null;
    const recordedTransactions = [];
    for (const tx of transactionsData) {
      const type = String(tx?.type || "").toUpperCase();
      if (!["SHARE_PURCHASE", "SOCIAL_FUND"].includes(type)) {
        throw new Error(`Transaction type ${type || "(empty)"} is not allowed through member contributions. Fine penalties are assessed as outstanding fines and paid through the fine repayment workflow.`);
      }
      const amount = Number(tx.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`${type} amount must be greater than zero.`);
      const safeAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
      const sharesCount = type === "SHARE_PURCHASE" ? Number(tx.sharesCount) : 0;
      if (type === "SHARE_PURCHASE" && (!Number.isSafeInteger(sharesCount) || sharesCount <= 0)) {
        throw new Error("Shares purchased must be a positive whole number.");
      }
      if (type === "SHARE_PURCHASE") {
        const expectedShareAmount = Math.round((sharesCount * shareValue + Number.EPSILON) * 100) / 100;
        if (Math.abs(safeAmount - expectedShareAmount) > 0.009) {
          throw new Error(`Share purchase amount must equal ${sharesCount} × ${shareValue.toLocaleString()} RWF = ${expectedShareAmount.toLocaleString()} RWF.`);
        }
      }
      const fineReason = type === "FINE_PAYMENT" ? String(tx.fineReason || "General fine").trim().slice(0, 255) : null;

      const [result] = await connection.query(
        `INSERT INTO transactions
          (group_id, cycle_id, meeting_id, member_id, type, amount, shares_count, fine_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, type, safeAmount, sharesCount || 0, fineReason],
      );

      const isSocialFund = type === "SOCIAL_FUND";
      const ledgerEntryId = await insertLedgerEntry(connection, {
        groupId: parsedGroupId,
        cycleId: parsedCycleId,
        meetingId: parsedMeetingId,
        memberId: parsedMemberId,
        fundType: isSocialFund ? "SOCIAL_FUND" : "LOAN_FUND",
        entryType: type === "SHARE_PURCHASE" ? "SHARE_PURCHASE" : type === "FINE_PAYMENT" ? "FINE_PAYMENT" : "SOCIAL_FUND_CONTRIBUTION",
        direction: "IN",
        amount: safeAmount,
        profitEffect: type === "FINE_PAYMENT" ? safeAmount : 0,
        notes: fineReason,
        sourceType: "TRANSACTION",
        sourceId: result.insertId,
        sourceComponent: "TOTAL",
        createdBy: parsedCreatedBy,
      });
      const receipt = await createReceipt(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        memberId: parsedMemberId, sourceType: "TRANSACTION", sourceId: result.insertId,
        sourceComponent: "TOTAL", activityType: type, amount: safeAmount,
        summary: type === "SHARE_PURCHASE" ? `${sharesCount} share(s) purchased` : type === "FINE_PAYMENT" ? `Fine payment: ${fineReason}` : "Social Fund contribution",
        details: { transactionId: result.insertId, ledgerEntryId, sharesCount: sharesCount || 0, fineReason, fundType: isSocialFund ? "SOCIAL_FUND" : "LOAN_FUND" },
        issuedBy: parsedCreatedBy,
      });
      await writeAuditEvent(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        actorUserId: parsedCreatedBy, action: "FINANCIAL_TRANSACTION_RECORDED", entityType: "TRANSACTION", entityId: result.insertId,
        afterData: { memberId: parsedMemberId, type, amount: safeAmount, sharesCount: sharesCount || 0, fineReason, receiptNumber: receipt.receiptNumber }, ...auditMeta,
      });
      if (type === "FINE_PAYMENT") {
        await connection.query(
          `UPDATE cycles SET total_fines_collected = COALESCE(total_fines_collected, 0) + ?
           WHERE id = ? AND group_id = ?`,
          [safeAmount, parsedCycleId, parsedGroupId],
        );
      }
      recordedTransactions.push({ transactionId: result.insertId, ledgerEntryId, type, amount: safeAmount, sharesCount, fineReason, receipt });
    }

    let savedFineAssessment = null;
    if (resolvedFine) {
      const [fineResult] = await connection.query(
        `INSERT INTO fine_assessments
          (group_id, cycle_id, meeting_id, member_id, fine_label, reason, amount, amount_paid, status, assessed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'OUTSTANDING', ?)`,
        [parsedGroupId, parsedCycleId, parsedMeetingId, parsedMemberId, resolvedFine.fineLabel, resolvedFine.reason, resolvedFine.amount, parsedCreatedBy],
      );
      savedFineAssessment = {
        fineId: Number(fineResult.insertId),
        memberId: parsedMemberId,
        fineLabel: resolvedFine.fineLabel,
        reason: resolvedFine.reason,
        amount: resolvedFine.amount,
        amountPaid: 0,
        balanceRemaining: resolvedFine.amount,
        status: "OUTSTANDING",
      };
      await writeAuditEvent(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        actorUserId: parsedCreatedBy, action: "FINE_ASSESSED", entityType: "FINE_ASSESSMENT", entityId: fineResult.insertId,
        afterData: savedFineAssessment,
        reason: `Fine assessed: ${resolvedFine.fineLabel}${resolvedFine.reason !== resolvedFine.fineLabel ? ` — ${resolvedFine.reason}` : ""}`,
        ...auditMeta,
      });
    }

    await connection.commit();
    return { transactions: recordedTransactions, fineAssessment: savedFineAssessment };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw new Error(`Transaction failed: ${error.message}`);
  } finally {
    connection.release();
  }
}

module.exports = { openMeeting, closeMeeting, recordMeetingTransactions };
