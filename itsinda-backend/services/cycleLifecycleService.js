"use strict";

const db = require("../config/db");
const { calculateShareOut } = require("./shareOutService");
const { getBookBalance, getLastLedgerEntryId, insertLedgerEntry, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { positiveId, cashAmount, mapPayout, findOtherLiveCycle } = require("./cycleLifecycleHelpers");

function statusError(message, statusCode = 409, blockingReasons = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (blockingReasons) error.blockingReasons = blockingReasons;
  return error;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

async function getCycleLifecycle(groupId, cycleId) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const [cycleRows] = await db.query(
    `SELECT id, group_id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
        DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status
     FROM cycles WHERE id = ? AND group_id = ? LIMIT 1`, [cid, gid],
  );
  if (!cycleRows.length) throw statusError("The selected cycle was not found in this group.", 404);
  const cycle = cycleRows[0];
  const [closureRows] = await db.query(
    `SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? AND status <> 'CANCELLED' LIMIT 1`, [gid, cid],
  );
  const [openRows] = await db.query(
    `SELECT id, meeting_number, date FROM meetings
     WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN'
     ORDER BY meeting_number, id`, [gid, cid],
  );
  const [lastMeetingRows] = await db.query(
    `SELECT id, meeting_number, date, status FROM meetings
     WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number DESC, id DESC LIMIT 1`, [gid, cid],
  );

  const [witnessRows] = lastMeetingRows.length ? await db.query(
    `SELECT u.id, u.full_name FROM meeting_attendance ma
     JOIN users u ON u.id = ma.member_id AND u.group_id = ma.group_id
     WHERE ma.group_id = ? AND ma.cycle_id = ? AND ma.meeting_id = ?
       AND ma.attendance_status = 'PRESENT' AND COALESCE(u.is_active, 1) = 1
     ORDER BY u.full_name`, [gid, cid, lastMeetingRows[0].id],
  ) : [[]];

  if (closureRows.length) {
    const closure = closureRows[0];
    const [payoutRows] = await db.query(
      `SELECT p.*, u.full_name, u.phone_number
       FROM cycle_shareout_payouts p
       LEFT JOIN users u ON u.id = p.member_id
       WHERE p.group_id = ? AND p.cycle_id = ?
       ORDER BY u.full_name, p.member_id`, [gid, cid],
    );
    const balanceConnection = await db.getConnection();
    let closingLoanBookBalance;
    let closingSocialBookBalance;
    try {
      closingLoanBookBalance = await getBookBalance(balanceConnection, gid, cid, "LOAN_FUND");
      closingSocialBookBalance = await getBookBalance(balanceConnection, gid, cid, "SOCIAL_FUND");
    } finally {
      balanceConnection.release();
    }
    return {
      success: true, cycle, openMeetings: openRows,
      lastMeeting: lastMeetingRows[0] || null,
      currentBookBalances: { loanFund: closingLoanBookBalance, socialFund: closingSocialBookBalance },
      witnesses: witnessRows.map((row) => ({ id: Number(row.id), fullName: row.full_name })),
      closure: {
        id: Number(closure.id), status: closure.status,
        distributableCash: roundMoney(closure.distributable_cash),
        socialFundCashToCarry: roundMoney(closure.social_fund_cash_at_start),
        snapshot: parseJson(closure.snapshot_json),
        finalLoanFundCash: closure.final_loan_fund_cash == null ? null : roundMoney(closure.final_loan_fund_cash),
        finalSocialFundCash: closure.final_social_fund_cash == null ? null : roundMoney(closure.final_social_fund_cash),
        nextCycleId: closure.next_cycle_id == null ? null : Number(closure.next_cycle_id),
        createdAt: closure.created_at, completedAt: closure.completed_at,
        payouts: payoutRows.map(mapPayout),
      },
      readyToPrepare: false, blockingReasons: [],
    };
  }

  if (cycle.status === "CLOSING") {
    throw statusError("This cycle is marked as closing, but its closure record is missing. Do not make manual changes; ask an administrator to inspect the database.", 503);
  }
  if (cycle.status === "COMPLETED") {
    return { success: true, cycle, openMeetings: openRows, lastMeeting: lastMeetingRows[0] || null, witnesses: [], closure: null, readyToPrepare: false, blockingReasons: ["This cycle is already completed."] };
  }

  const report = await calculateShareOut(gid, cid);
  const blockingReasons = [...(report.blockingReasons || [])];
  if (!lastMeetingRows.length) blockingReasons.unshift("At least one meeting must exist before the cycle can be closed.");
  if (openRows.length) blockingReasons.unshift(`Close all ${openRows.length} open meeting(s) before starting cycle share-out.`);
  return {
    success: true, cycle, report, openMeetings: openRows,
    lastMeeting: lastMeetingRows[0] || null,
    witnesses: witnessRows.map((row) => ({ id: Number(row.id), fullName: row.full_name })),
    closure: null, currentBookBalances: { loanFund: report.cashbook.funds.LOAN_FUND.bookBalance, socialFund: report.cashbook.funds.SOCIAL_FUND.bookBalance },
    readyToPrepare: blockingReasons.length === 0 && cycle.status === "ACTIVE", blockingReasons,
  };
}

async function prepareCycleClosure(groupId, cycleId, actorUserId, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Lock the group first so two cycle transitions for the same group serialize.
    const [groupRows] = await connection.query("SELECT id FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw statusError("The group was not found.", 404);
    const [cycleRows] = await connection.query(
      `SELECT id, group_id, cycle_number, start_date, status FROM cycles
       WHERE id = ? AND group_id = ? FOR UPDATE`, [cid, gid],
    );
    if (!cycleRows.length) throw statusError("The selected cycle was not found in this group.", 404);
    if (cycleRows[0].status !== "ACTIVE") throw statusError("Only an active cycle can begin share-out.");
    const [otherLiveCycleRows] = await connection.query(
      `SELECT id, cycle_number, status FROM cycles
       WHERE group_id = ? AND id <> ? AND status IN ('ACTIVE', 'CLOSING') FOR UPDATE`, [gid, cid],
    );
    const otherLiveCycle = findOtherLiveCycle(otherLiveCycleRows, cid);
    if (otherLiveCycle) {
      throw statusError(`Cycle #${otherLiveCycle.cycle_number} is already ${otherLiveCycle.status}. Resolve that cycle before beginning another cycle's share-out.`);
    }
    const [existingClosure] = await connection.query(
      "SELECT id, status FROM cycle_closures WHERE group_id = ? AND cycle_id = ? LIMIT 1 FOR UPDATE", [gid, cid],
    );
    if (existingClosure.length && existingClosure[0].status !== "CANCELLED") throw statusError("Share-out has already been prepared for this cycle. Continue with the saved payout list.");
    if (existingClosure.length) {
      const [paidRows] = await connection.query(
        `SELECT COUNT(*) AS paid_count FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ? AND status = 'PAID'`, [gid, cid],
      );
      if (Number(paidRows[0]?.paid_count || 0) > 0) throw statusError("A cancelled share-out cannot be restarted because a payout has already been recorded.");
      const [ledgerRows] = await connection.query(
        `SELECT COUNT(*) AS payout_ledger_count FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND source_type = 'CYCLE_PAYOUT'`, [gid, cid],
      );
      if (Number(ledgerRows[0]?.payout_ledger_count || 0) > 0) throw statusError("A payout ledger entry already exists. Do not restart this share-out; ask an administrator to review the cycle history.");
      await connection.query("DELETE FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ?", [gid, cid]);
    }
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number, status FROM meetings WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number, id`, [gid, cid],
    );
    if (!meetingRows.length) throw statusError("At least one meeting must exist before the cycle can be closed.");
    const openMeetings = meetingRows.filter((meeting) => meeting.status === "OPEN");
    if (openMeetings.length) throw statusError(`Close Meeting #${openMeetings[0].meeting_number} before starting cycle share-out.`);

    // The cycle row is locked so financial write paths that lock the same row cannot
    // change balances between this readiness check and switching the cycle to CLOSING.
    const report = await calculateShareOut(gid, cid);
    if (!report.readyForDistribution) {
      throw statusError("The cycle is not ready for share-out. Resolve the listed items first.", 409, report.blockingReasons || []);
    }
    const preShareoutLoanCash = roundMoney(report.distributableCash);
    const payoutTotal = roundMoney((report.payouts || []).reduce((sum, payout) => sum + Number(payout.totalPayout || 0), 0));
    if (Math.abs(payoutTotal - preShareoutLoanCash) >= 0.01) {
      throw statusError("The member payout total does not equal the reconciled Loan Fund cash. Share-out was not prepared; review the payout calculation first.", 409);
    }
    const preShareoutSocialCash = roundMoney(report.cashbook.funds.SOCIAL_FUND.latestReconciliation.countedCash);
    const snapshot = {
      cycleId: cid, cycleNumber: Number(cycleRows[0].cycle_number),
      preparedAt: new Date().toISOString(), baseShareValue: report.baseShareValue,
      totalShares: report.totalShares, totalSavingsValue: report.totalSavingsValue,
      totalNetProfit: report.totalNetProfit, finalShareValue: report.finalShareValue,
      distributableCash: preShareoutLoanCash, socialFundCarryForward: preShareoutSocialCash,
      memberBreakdown: report.memberBreakdown, payouts: report.payouts,
    };
    let closureId;
    if (existingClosure.length) {
      closureId = Number(existingClosure[0].id);
      await connection.query(
        `UPDATE cycle_closures SET status = 'DISTRIBUTING', distributable_cash = ?, social_fund_cash_at_start = ?,
         snapshot_json = ?, final_loan_fund_cash = NULL, final_social_fund_cash = NULL, witness_member_id = NULL,
         next_cycle_id = NULL, created_by = ?, closed_by = NULL, created_at = CURRENT_TIMESTAMP, completed_at = NULL
         WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'CANCELLED'`,
        [preShareoutLoanCash, preShareoutSocialCash, JSON.stringify(snapshot), actor, closureId, gid, cid],
      );
    } else {
      const [closureResult] = await connection.query(
        `INSERT INTO cycle_closures
         (group_id, cycle_id, status, distributable_cash, social_fund_cash_at_start, snapshot_json, created_by)
         VALUES (?, ?, 'DISTRIBUTING', ?, ?, ?, ?)`,
        [gid, cid, preShareoutLoanCash, preShareoutSocialCash, JSON.stringify(snapshot), actor],
      );
      closureId = Number(closureResult.insertId);
    }
    for (const payout of report.payouts) {
      const amount = roundMoney(payout.totalPayout || 0);
      await connection.query(
        `INSERT INTO cycle_shareout_payouts
         (group_id, cycle_id, member_id, shares_count, savings_amount, profit_amount, payout_amount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [gid, cid, positiveId(payout.memberId, "Payout member ID"), Number(payout.sharesOwned || 0), roundMoney(payout.originalInvestment || 0), roundMoney(payout.profitEarned || 0), amount, amount > 0 ? "PENDING" : "NOT_PAYABLE"],
      );
    }
    await connection.query("UPDATE cycles SET status = 'CLOSING' WHERE id = ? AND group_id = ? AND status = 'ACTIVE'", [cid, gid]);
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PREPARED",
      entityType: "CYCLE_CLOSURE", entityId: closureId,
      beforeData: { status: "ACTIVE" }, afterData: { status: "CLOSING", distributableCash: preShareoutLoanCash, socialFundCarryForward: preShareoutSocialCash, payoutCount: report.payouts.length, snapshot },
      ...auditMeta,
    });
    await connection.commit();
    return { closureId, cycleId: cid, status: "DISTRIBUTING", distributableCash: preShareoutLoanCash, payoutCount: report.payouts.length };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function recordCyclePayout(groupId, cycleId, payoutId, actorUserId, confirmedHandedOver, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const pid = positiveId(payoutId, "Payout ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  if (confirmedHandedOver !== true) throw new Error("Confirm that the full cash payout has physically been handed to the member.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycles] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycles.length || cycles[0].status !== "CLOSING") throw statusError("This cycle is not in the share-out payment stage.");
    const [closures] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closures.length || closures[0].status !== "DISTRIBUTING") throw statusError("The share-out payout register is not open.");
    const [payoutRows] = await connection.query(
      `SELECT p.*, u.full_name FROM cycle_shareout_payouts p
       JOIN users u ON u.id = p.member_id
       WHERE p.id = ? AND p.group_id = ? AND p.cycle_id = ? FOR UPDATE`, [pid, gid, cid],
    );
    if (!payoutRows.length) throw statusError("The selected payout was not found.", 404);
    const payout = payoutRows[0];
    if (payout.status !== "PENDING") throw statusError("This payout has already been recorded or is not payable.");
    const amount = roundMoney(payout.payout_amount);
    const available = await getBookBalance(connection, gid, cid, "LOAN_FUND");
    if (available + 0.009 < amount) throw statusError("The remaining Loan Fund ledger balance is too low for this payout. Stop and investigate; do not record a manual adjustment to bypass this check.");

    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: gid, cycleId: cid, memberId: Number(payout.member_id), fundType: "LOAN_FUND",
      entryType: "SHARE_OUT_DISTRIBUTION", direction: "OUT", amount, profitEffect: 0,
      notes: `Cycle ${closures[0].cycle_id} share-out payment to ${payout.full_name}`,
      sourceType: "CYCLE_PAYOUT", sourceId: pid, sourceComponent: "TOTAL", createdBy: actor,
    });
    const receipt = await createReceipt(connection, {
      groupId: gid, cycleId: cid, memberId: Number(payout.member_id), sourceType: "CYCLE_PAYOUT",
      sourceId: pid, sourceComponent: "TOTAL", activityType: "SHARE_OUT_PAYOUT", amount,
      summary: `Cycle share-out payout to ${payout.full_name}`,
      details: { payoutId: pid, cycleId: cid, shares: Number(payout.shares_count), savingsAmount: roundMoney(payout.savings_amount), profitAmount: roundMoney(payout.profit_amount), cashDisbursed: amount },
      issuedBy: actor,
    });
    await connection.query(
      `UPDATE cycle_shareout_payouts SET status = 'PAID', ledger_entry_id = ?, receipt_id = ?, paid_by = ?, paid_at = CURRENT_TIMESTAMP
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'PENDING'`,
      [ledgerEntryId, receipt.id, actor, pid, gid, cid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PAYOUT_RECORDED",
      entityType: "CYCLE_SHAREOUT_PAYOUT", entityId: pid, reason: "Leadership confirmed cash was physically handed to the member.",
      beforeData: { status: "PENDING" }, afterData: { status: "PAID", memberId: Number(payout.member_id), memberName: payout.full_name, amount, ledgerEntryId, receiptId: receipt.id }, ...auditMeta,
    });
    await connection.commit();
    return { payoutId: pid, memberId: Number(payout.member_id), memberName: payout.full_name, amount, status: "PAID", receipt };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function cancelCycleClosure(groupId, cycleId, actorUserId, reason, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  const why = String(reason || "").trim();
  if (why.length < 5) throw new Error("Explain why share-out preparation is being cancelled (at least 5 characters).");
  if (why.length > 1000) throw new Error("The cancellation explanation cannot exceed 1,000 characters.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [cycleRows] = await connection.query("SELECT id, status FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "CLOSING") throw statusError("This cycle is not in a share-out closing state.");
    const [closureRows] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closureRows.length || closureRows[0].status !== "DISTRIBUTING") throw statusError("The share-out preparation cannot be cancelled in its current state.");
    const [paidRows] = await connection.query(
      `SELECT COUNT(*) AS paid_count FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ? AND status = 'PAID'`, [gid, cid],
    );
    const [ledgerRows] = await connection.query(
      `SELECT COUNT(*) AS payout_ledger_count FROM fund_ledger_entries WHERE group_id = ? AND cycle_id = ? AND source_type = 'CYCLE_PAYOUT'`, [gid, cid],
    );
    if (Number(paidRows[0]?.paid_count || 0) > 0 || Number(ledgerRows[0]?.payout_ledger_count || 0) > 0) {
      throw statusError("Share-out preparation cannot be cancelled after any member payout has been recorded. Finish the saved payout list instead.");
    }
    await connection.query("UPDATE cycle_closures SET status = 'CANCELLED' WHERE id = ? AND status = 'DISTRIBUTING'", [Number(closureRows[0].id)]);
    await connection.query("UPDATE cycles SET status = 'ACTIVE' WHERE id = ? AND group_id = ? AND status = 'CLOSING'", [cid, gid]);
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_SHAREOUT_PREPARATION_CANCELLED",
      entityType: "CYCLE_CLOSURE", entityId: closureRows[0].id, reason: why,
      beforeData: { cycleStatus: "CLOSING", closureStatus: "DISTRIBUTING" },
      afterData: { cycleStatus: "ACTIVE", closureStatus: "CANCELLED", noPayoutsRecorded: true }, ...auditMeta,
    });
    await connection.commit();
    return { cycleId: cid, status: "ACTIVE", message: "Share-out preparation was cancelled before any payout. The active cycle has been unlocked." };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function completeCycleAndStartNext(groupId, cycleId, input, actorUserId, auditMeta = {}) {
  const gid = positiveId(groupId, "Group ID");
  const cid = positiveId(cycleId, "Cycle ID");
  const actor = positiveId(actorUserId, "Acting user ID");
  const finalLoanCash = cashAmount(input.finalLoanFundCash, "Final Loan Fund cash count");
  const finalSocialCash = cashAmount(input.finalSocialFundCash, "Final Social Fund cash count");
  const witnessMemberId = positiveId(input.witnessMemberId, "Witness member ID");
  if (input.confirmAllPayoutsAndCounts !== true) throw new Error("Confirm that all payouts are complete and both physical cash counts have been performed.");
  if (input.carrySocialFundForward !== true) throw new Error("This workflow carries the separate Social Fund forward into the next cycle. A different Social Fund distribution policy must be recorded through an approved dedicated process before it can be supported here.");

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Serialize cycle transitions for a group to avoid creating two next cycles concurrently.
    const [groupRows] = await connection.query("SELECT id FROM `groups` WHERE id = ? FOR UPDATE", [gid]);
    if (!groupRows.length) throw statusError("The group was not found.", 404);
    const [cycleRows] = await connection.query("SELECT * FROM cycles WHERE id = ? AND group_id = ? FOR UPDATE", [cid, gid]);
    if (!cycleRows.length || cycleRows[0].status !== "CLOSING") throw statusError("The selected cycle is not waiting for share-out completion.");
    const [otherLiveCycleRows] = await connection.query(
      `SELECT id, cycle_number, status FROM cycles
       WHERE group_id = ? AND id <> ? AND status IN ('ACTIVE', 'CLOSING') FOR UPDATE`, [gid, cid],
    );
    const otherLiveCycle = findOtherLiveCycle(otherLiveCycleRows, cid);
    if (otherLiveCycle) {
      throw statusError(`Cycle #${otherLiveCycle.cycle_number} is already ${otherLiveCycle.status}. It must be resolved before a new cycle can start.`);
    }
    const [closureRows] = await connection.query("SELECT * FROM cycle_closures WHERE group_id = ? AND cycle_id = ? FOR UPDATE", [gid, cid]);
    if (!closureRows.length || closureRows[0].status !== "DISTRIBUTING") throw statusError("The share-out register is not ready to be completed.");
    const closure = closureRows[0];
    const [pendingRows] = await connection.query(
      `SELECT COUNT(*) AS pending_count FROM cycle_shareout_payouts
       WHERE group_id = ? AND cycle_id = ? AND status = 'PENDING'`, [gid, cid],
    );
    if (Number(pendingRows[0]?.pending_count || 0) > 0) throw statusError(`${Number(pendingRows[0].pending_count)} member payout(s) remain unrecorded. Pay and record every payout before completing the cycle.`);
    const [meetingRows] = await connection.query(
      `SELECT id, meeting_number, status, date FROM meetings
       WHERE group_id = ? AND cycle_id = ? ORDER BY meeting_number DESC, id DESC LIMIT 1 FOR UPDATE`, [gid, cid],
    );
    if (!meetingRows.length || meetingRows[0].status !== "CLOSED") throw statusError("The final meeting must exist and be closed before completing the cycle.");
    const lastMeetingId = Number(meetingRows[0].id);
    const [witnessRows] = await connection.query(
      `SELECT u.id, u.full_name FROM users u
       JOIN meeting_attendance ma ON ma.member_id = u.id AND ma.group_id = u.group_id
       WHERE u.id = ? AND u.group_id = ? AND u.is_active = 1 AND ma.cycle_id = ?
         AND ma.meeting_id = ? AND ma.attendance_status = 'PRESENT' LIMIT 1 FOR UPDATE`,
      [witnessMemberId, gid, cid, lastMeetingId],
    );
    if (!witnessRows.length) throw statusError("Choose a group member marked Present in the final meeting to witness the final cash count.");

    const loanBookBalance = await getBookBalance(connection, gid, cid, "LOAN_FUND");
    const socialBookBalance = await getBookBalance(connection, gid, cid, "SOCIAL_FUND");
    const payoutTotalRows = await connection.query(
      `SELECT COALESCE(SUM(payout_amount), 0) AS payout_total FROM cycle_shareout_payouts WHERE group_id = ? AND cycle_id = ?`, [gid, cid],
    );
    if (Math.abs(roundMoney(payoutTotalRows[0][0]?.payout_total || 0) - roundMoney(closure.distributable_cash)) >= 0.01) {
      throw statusError("The recorded member payout register does not add up to the frozen share-out amount. Do not close the cycle; ask leadership to review the payout register.");
    }
    if (loanBookBalance > 0.009) throw statusError(`The Loan Fund still has ${loanBookBalance.toLocaleString()} RWF in the ledger after share-out payouts. Distribute or formally resolve the remainder before starting a new cycle.`);
    const loanVariance = roundMoney(finalLoanCash - loanBookBalance);
    const socialVariance = roundMoney(finalSocialCash - socialBookBalance);
    if (Math.abs(loanVariance) >= 0.01) throw statusError(`Final Loan Fund count differs from the post-payout cashbook by ${loanVariance.toLocaleString()} RWF. Investigate and reconcile before starting another cycle.`);
    if (Math.abs(socialVariance) >= 0.01) throw statusError(`Final Social Fund count differs from the cashbook by ${socialVariance.toLocaleString()} RWF. Investigate and reconcile before starting another cycle.`);
    if (loanBookBalance < -0.009 || socialBookBalance < -0.009) throw statusError("A fund has a negative closing balance. Correct the underlying records before completing the cycle.");

    const loanLastEntry = await getLastLedgerEntryId(connection, gid, cid, "LOAN_FUND");
    const socialLastEntry = await getLastLedgerEntryId(connection, gid, cid, "SOCIAL_FUND");
    for (const row of [
      { fundType: "LOAN_FUND", book: loanBookBalance, counted: finalLoanCash, variance: loanVariance, lastEntry: loanLastEntry },
      { fundType: "SOCIAL_FUND", book: socialBookBalance, counted: finalSocialCash, variance: socialVariance, lastEntry: socialLastEntry },
    ]) {
      await connection.query(
        `INSERT INTO cash_reconciliations
         (group_id, cycle_id, meeting_id, fund_type, book_balance_at_count, counted_cash, variance,
          ledger_entry_id_at_count, notes, reconciled_by, witness_member_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [gid, cid, lastMeetingId, row.fundType, row.book, row.counted, row.variance, row.lastEntry,
          "Final physical cash count recorded during cycle closure after share-out payments.", actor, witnessMemberId],
      );
    }

    const [maxRows] = await connection.query("SELECT COALESCE(MAX(cycle_number), 0) AS max_cycle_number FROM cycles WHERE group_id = ?", [gid]);
    const nextCycleNumber = Number(maxRows[0]?.max_cycle_number || 0) + 1;
    await connection.query("UPDATE cycles SET status = 'COMPLETED', end_date = CURDATE() WHERE id = ? AND group_id = ? AND status = 'CLOSING'", [cid, gid]);
    const [nextCycleResult] = await connection.query(
      "INSERT INTO cycles (group_id, cycle_number, start_date, status) VALUES (?, ?, CURDATE(), 'ACTIVE')", [gid, nextCycleNumber],
    );
    const nextCycleId = Number(nextCycleResult.insertId);
    const [nextCycleRows] = await connection.query("SELECT id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, status FROM cycles WHERE id = ? AND group_id = ?", [nextCycleId, gid]);
    const nextCycleRow = nextCycleRows[0];
    const startDate = String(nextCycleRow.start_date).slice(0, 10);
    if (finalSocialCash > 0) {
      await insertLedgerEntry(connection, {
        groupId: gid, cycleId: nextCycleId, fundType: "SOCIAL_FUND", entryType: "OPENING_BALANCE", direction: "IN",
        amount: finalSocialCash, profitEffect: 0, notes: `Social Fund carried forward from Cycle ${Number(cycleRows[0].cycle_number)}.`,
        sourceType: "CYCLE_CARRY_FORWARD", sourceId: cid, sourceComponent: "SOCIAL_FUND", createdBy: actor,
      });
    }
    await connection.query(
      `UPDATE cycle_closures SET status = 'COMPLETED', final_loan_fund_cash = ?, final_social_fund_cash = ?,
       witness_member_id = ?, next_cycle_id = ?, closed_by = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'DISTRIBUTING'`,
      [finalLoanCash, finalSocialCash, witnessMemberId, nextCycleId, actor, Number(closure.id), gid, cid],
    );
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: cid, actorUserId: actor, action: "CYCLE_COMPLETED_AND_NEXT_CYCLE_STARTED",
      entityType: "CYCLE_CLOSURE", entityId: closure.id,
      reason: "All share-out payouts were recorded; final physical cash counts matched the ledger; the Social Fund was carried forward.",
      beforeData: { cycleStatus: "CLOSING", closureStatus: "DISTRIBUTING" },
      afterData: { cycleStatus: "COMPLETED", endDate: "CURDATE()", finalLoanFundCash: finalLoanCash, finalSocialFundCash: finalSocialCash, witnessMemberId, nextCycle: { id: nextCycleId, cycleNumber: nextCycleNumber, startDate }, socialFundCarriedForward: finalSocialCash },
      ...auditMeta,
    });
    await writeAuditEvent(connection, {
      groupId: gid, cycleId: nextCycleId, actorUserId: actor, action: "NEXT_CYCLE_CREATED", entityType: "CYCLE", entityId: nextCycleId,
      afterData: { cycleNumber: nextCycleNumber, startDate, status: "ACTIVE", socialFundOpeningBalance: finalSocialCash, carriedFromCycleId: cid }, ...auditMeta,
    });
    await connection.commit();
    return { completedCycle: { id: cid, cycleNumber: Number(cycleRows[0].cycle_number), status: "COMPLETED" }, nextCycle: { id: nextCycleId, cycle_number: nextCycleNumber, start_date: startDate, status: "ACTIVE" }, finalCounts: { loanFund: finalLoanCash, socialFund: finalSocialCash }, witnessName: witnessRows[0].full_name };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = { getCycleLifecycle, prepareCycleClosure, recordCyclePayout, cancelCycleClosure, completeCycleAndStartNext };
