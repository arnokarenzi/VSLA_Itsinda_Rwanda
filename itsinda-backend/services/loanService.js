const db = require("../config/db");
const { insertLedgerEntry, getBookBalance, getLastLedgerEntryId, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { calculateInterestAmount } = require("./constitutionRules");
const { periodicChargesDue, calculateInterestOnRemainingPrincipal, allocateRepayment } = require("./loanCalculations");

// These fallback values are retained for older group records, but should eventually
// be replaced by constitution-approved settings stored for each group.
const DEFAULT_LOAN_SETTINGS = Object.freeze({
  shareValue: 1000,
  loanRatioLimit: 3,
  monthlyInterestRate: 0.05,
  interestRate: 0.05,
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: 30,
  maxLoanTermDays: 30,
  maxLoanDurationMonths: 1, // legacy fallback only
});

function parseSettings(rawSettings) {
  if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) return rawSettings;
  if (typeof rawSettings === "string") {
    try {
      const parsed = JSON.parse(rawSettings);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      throw new Error("Group settings contain invalid JSON.");
    }
  }
  return {};
}

function readNumericSetting(settings, key, { min = 0, exclusiveMin = false, max = Infinity } = {}) {
  const rawValue = settings[key] ?? DEFAULT_LOAN_SETTINGS[key];
  const value = Number(rawValue);
  const belowMinimum = exclusiveMin ? value <= min : value < min;
  if (rawValue === "" || !Number.isFinite(value) || belowMinimum || value > max) {
    const maximumText = Number.isFinite(max) ? ` and no more than ${max}` : "";
    throw new Error(`Group loan setting "${key}" must be a valid number ${exclusiveMin ? "greater than" : "at least"} ${min}${maximumText}.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function requirePositiveAmount(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a number greater than zero.`);
  const rounded = roundMoney(parsed);
  if (rounded <= 0) throw new Error(`${label} must be at least 0.01 RWF.`);
  return rounded;
}

function requireISODate(value, label) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} must be in YYYY-MM-DD format.`);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`);
  }
  return date;
}

async function requireOpenMeeting(connection, meetingId, groupId, cycleId) {
  const parsedMeetingId = requirePositiveInteger(meetingId, "Meeting ID");
  const [meetingRows] = await connection.query(
    `SELECT id FROM meetings
     WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'OPEN'
     FOR UPDATE`,
    [parsedMeetingId, groupId, cycleId],
  );
  if (!meetingRows.length) throw new Error("Select an open meeting for this group and active cycle before recording the loan cash movement.");
  return parsedMeetingId;
}

function addDaysIso(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + Number(days));
  return next.toISOString().slice(0, 10);
}

async function requireCurrentMeetingCashCount(connection, groupId, cycleId, meetingId) {
  const [rows] = await connection.query(
    `SELECT variance, ledger_entry_id_at_count, meeting_id
     FROM cash_reconciliations
     WHERE group_id = ? AND cycle_id = ? AND fund_type = 'LOAN_FUND'
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [groupId, cycleId],
  );
  if (!rows.length) throw new Error("Reconcile the Loan Fund while this meeting is open before issuing a loan.");
  const reconciliation = rows[0];
  if (Number(reconciliation.meeting_id) !== meetingId) {
    throw new Error("The Loan Fund must be counted and reconciled with this open meeting selected before issuing a loan.");
  }
  const latestLedgerId = await getLastLedgerEntryId(connection, groupId, cycleId, "LOAN_FUND");
  const countedLedgerId = reconciliation.ledger_entry_id_at_count == null ? null : Number(reconciliation.ledger_entry_id_at_count);
  if (latestLedgerId !== countedLedgerId) throw new Error("The Loan Fund book changed after the last count. Reconcile it again with this meeting selected before issuing a loan.");
  const variance = roundMoney(reconciliation.variance);
  if (Math.abs(variance) >= 0.01) throw new Error(`The Loan Fund has an unresolved cash variance of ${variance.toLocaleString()} RWF. Resolve it and reconcile again before issuing a loan.`);
}

/** Issues a loan without asking the borrower to choose a duration. The current constitution controls its day period. */
async function issueLoan(groupId, cycleId, memberId, principalAmount, meetingId, createdBy, auditMeta = {}) {
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedMemberId = requirePositiveInteger(memberId, "Borrower member ID");
  const principal = requirePositiveAmount(principalAmount, "Principal amount");
  const parsedCreatedBy = requirePositiveInteger(createdBy, "Recording user ID");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected financial cycle is not active for this group.");
    const parsedMeetingId = await requireOpenMeeting(connection, meetingId, parsedGroupId, parsedCycleId);

    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ? FOR UPDATE", [parsedGroupId]);
    if (!groupRows.length) throw new Error("Group not found.");
    const settings = parseSettings(groupRows[0].settings);
    const shareValue = readNumericSetting(settings, "shareValue", { min: 0, exclusiveMin: true, max: 100000000 });
    const loanRatioLimit = readNumericSetting(settings, "loanRatioLimit", { min: 0, exclusiveMin: true, max: 100 });
    const interestRate = readNumericSetting({ interestRate: settings.interestRate ?? settings.monthlyInterestRate ?? DEFAULT_LOAN_SETTINGS.interestRate }, "interestRate", { min: 0, max: 1 });
    const interestMethodRaw = String(settings.interestMethod || "FLAT_PER_PERIOD").toUpperCase();
    const interestMethod = interestMethodRaw === "FLAT_PER_MONTH" ? "FLAT_PER_PERIOD" : interestMethodRaw;
    if (!["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(interestMethod)) throw new Error("The group constitution has an unsupported interest calculation method.");
    const fallbackDays = Number(settings.maxLoanDurationMonths || DEFAULT_LOAN_SETTINGS.maxLoanDurationMonths) * 30;
    const interestPeriodDays = requirePositiveInteger(settings.interestPeriodDays ?? settings.maxLoanTermDays ?? fallbackDays, "Constitution interest period in days");
    const maxLoanTermDays = requirePositiveInteger(settings.maxLoanTermDays ?? settings.interestPeriodDays ?? fallbackDays, "Constitution maximum loan term in days");
    if (interestPeriodDays !== maxLoanTermDays) throw new Error("The constitution is inconsistent: interest period and maximum initial loan term must use the same number of days. Submit and approve corrected rules.");

    const [memberRows] = await connection.query(
      "SELECT id FROM users WHERE id = ? AND group_id = ? AND is_active = 1",
      [parsedMemberId, parsedGroupId],
    );
    if (!memberRows.length) throw new Error("The selected borrower is not an active member of this group.");

    const [shareRows] = await connection.query(
      `SELECT COALESCE(SUM(shares_count), 0) AS total_shares
       FROM transactions
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'`,
      [parsedGroupId, parsedCycleId, parsedMemberId],
    );
    const totalShares = Number(shareRows[0]?.total_shares ?? 0);
    if (!Number.isFinite(totalShares) || totalShares < 0) throw new Error("Could not calculate the borrower's savings.");
    const savingsValue = roundMoney(totalShares * shareValue);
    const maxBorrowLimit = roundMoney(savingsValue * loanRatioLimit);
    if (principal > maxBorrowLimit) throw new Error(`Loan request exceeds the maximum allowed limit of ${maxBorrowLimit.toLocaleString()} RWF (based on ${loanRatioLimit}x savings).`);

    // Count must be current, balanced, and tied to this still-open meeting. Loan disbursement then invalidates the count.
    await requireCurrentMeetingCashCount(connection, parsedGroupId, parsedCycleId, parsedMeetingId);
    const cashAvailable = await getBookBalance(connection, parsedGroupId, parsedCycleId, "LOAN_FUND");
    if (principal > cashAvailable + 0.001) throw new Error(`The Loan Fund has ${cashAvailable.toLocaleString()} RWF available, which is not enough to disburse ${principal.toLocaleString()} RWF.`);

    // Both approved methods charge immediately when the loan is disbursed.
    // FLAT_PER_PERIOD then adds one further flat charge for every completed period.
    const initialInterest = calculateInterestAmount(principal, interestRate, 1, interestMethod);
    const initialTotalDue = roundMoney(principal + initialInterest);
    const issuedAt = new Date();
    const dueDate = addDaysIso(issuedAt, maxLoanTermDays);
    const chargedPeriods = interestMethod === "FLAT_PER_PERIOD" ? 1 : 0;
    const [loanResult] = await connection.query(
      `INSERT INTO loans
        (group_id, cycle_id, member_id, principal_amount, interest_rate, interest_method,
         interest_period_days, interest_periods_charged, total_interest_due, total_amount_due,
         balance_remaining, due_date, status, disbursed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)`,
      [parsedGroupId, parsedCycleId, parsedMemberId, principal, interestRate, interestMethod,
        interestPeriodDays, chargedPeriods, initialInterest, initialTotalDue, initialTotalDue, dueDate],
    );

    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: parsedMemberId, loanId: loanResult.insertId, fundType: "LOAN_FUND",
      entryType: "LOAN_DISBURSEMENT", direction: "OUT", amount: principal, profitEffect: 0,
      notes: `Loan #${loanResult.insertId} disbursed to member ${parsedMemberId}.`,
      sourceType: "LOAN", sourceId: loanResult.insertId, sourceComponent: "DISBURSEMENT", createdBy: parsedCreatedBy,
    });
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId, memberId: parsedMemberId,
      sourceType: "LOAN", sourceId: loanResult.insertId, sourceComponent: "DISBURSEMENT",
      activityType: "LOAN_DISBURSEMENT", amount: principal,
      summary: `Loan #${loanResult.insertId} disbursed`,
      details: { loanId: loanResult.insertId, ledgerEntryId, principalAmount: principal, interestRate,
        interestMethod, interestPeriodDays, maxLoanTermDays, initialInterest, totalAmountDue: initialTotalDue, dueDate },
      issuedBy: parsedCreatedBy,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_ISSUED", entityType: "LOAN", entityId: loanResult.insertId,
      afterData: { memberId: parsedMemberId, principalAmount: principal, interestRate, interestMethod,
        interestPeriodDays, maxLoanTermDays, initialInterest, totalAmountDue: initialTotalDue, dueDate,
        receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    await connection.commit();
    transactionStarted = false;
    return { loanId: loanResult.insertId, principalAmount: principal, interestRate, interestMethod,
      interestPeriodDays, maxLoanTermDays, totalInterestDue: initialInterest, totalAmountDue: initialTotalDue,
      balanceRemaining: initialTotalDue, dueDate, meetingId: parsedMeetingId, receipt };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrappedError = new Error(`Loan issuance failed: ${error.message}`, { cause: error });
    wrappedError.code = error.code; wrappedError.sqlMessage = error.sqlMessage; wrappedError.sqlState = error.sqlState;
    throw wrappedError;
  } finally {
    connection.release();
  }
}

/** Repays interest first, then principal, and records both parts in the same DB transaction. */
async function repayLoan(loanId, repaymentAmount, cycleId, meetingId, groupId, createdBy, auditMeta = {}, expectedMemberId = null) {
  const parsedLoanId = requirePositiveInteger(loanId, "Loan ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCreatedBy = requirePositiveInteger(createdBy, "Recording user ID");
  const payment = requirePositiveAmount(repaymentAmount, "Repayment amount");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected financial cycle is not active for this group.");
    const parsedMeetingId = await requireOpenMeeting(connection, meetingId, parsedGroupId, parsedCycleId);

    const [loanRows] = await connection.query(
      `SELECT * FROM loans
       WHERE id = ? AND group_id = ? AND cycle_id = ? AND status = 'ACTIVE'
       FOR UPDATE`,
      [parsedLoanId, parsedGroupId, parsedCycleId],
    );
    if (!loanRows.length) throw new Error("Active loan not found in the selected group and cycle.");
    const loan = loanRows[0];
    if (expectedMemberId != null) {
      const parsedExpectedMemberId = requirePositiveInteger(expectedMemberId, "Borrower member ID");
      if (Number(loan.member_id) !== parsedExpectedMemberId) {
        throw new Error("The selected loan does not belong to the selected borrower.");
      }
    }
    let balance = roundMoney(loan.balance_remaining);
    let totalDue = roundMoney(loan.total_amount_due);
    let totalInterestDue = roundMoney(loan.total_interest_due);
    let periodsCharged = Number(loan.interest_periods_charged || 0);
    const interestMethod = String(loan.interest_method || "LEGACY_FIXED").toUpperCase();
    const usesTrackedSplit = ["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(interestMethod);
    const [priorRepaymentRows] = await connection.query(
      `SELECT COALESCE(SUM(COALESCE(principal_amount, 0)), 0) AS principal_paid,
          COALESCE(SUM(COALESCE(interest_amount, 0)), 0) AS interest_paid
       FROM transactions WHERE group_id = ? AND cycle_id = ? AND loan_id = ?
         AND type = 'LOAN_REPAYMENT' AND status = 'POSTED'`,
      [parsedGroupId, parsedCycleId, parsedLoanId],
    );
    const principalPaidPreviously = roundMoney(priorRepaymentRows[0]?.principal_paid || 0);
    const interestPaidPreviously = roundMoney(priorRepaymentRows[0]?.interest_paid || 0);

    let principalRemainingBeforePayment;
    let interestRemainingBeforePayment;
    if (usesTrackedSplit) {
      principalRemainingBeforePayment = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidPreviously));
      interestRemainingBeforePayment = Math.max(0, roundMoney(totalInterestDue - interestPaidPreviously));
      balance = roundMoney(principalRemainingBeforePayment + interestRemainingBeforePayment);
      totalDue = roundMoney(Number(loan.principal_amount) + totalInterestDue);
    } else {
      // Historical loans without an auditable split use the stored outstanding
      // balance as authoritative; do not invent principal paid from missing data.
      interestRemainingBeforePayment = Math.min(Math.max(0, totalInterestDue), Math.max(0, roundMoney(totalDue - balance)));
      principalRemainingBeforePayment = Math.max(0, roundMoney(balance - interestRemainingBeforePayment));
    }

    if (interestMethod === "FLAT_PER_PERIOD") {
      const periodDays = requirePositiveInteger(loan.interest_period_days, "Loan interest period in days");
      const targetPeriods = periodicChargesDue({ now: Date.now(), disbursedAt: loan.disbursed_at, periodDays });
      const unchargedPeriods = Math.max(0, targetPeriods - periodsCharged);
      if (unchargedPeriods > 0) {
        // Flat charges are calculated on principal still unpaid at the time this
        // accrual is processed. Earlier partial repayments reduce future charges.
        const newInterest = calculateInterestOnRemainingPrincipal(
          principalRemainingBeforePayment, Number(loan.interest_rate), unchargedPeriods,
        );
        totalInterestDue = roundMoney(totalInterestDue + newInterest);
        periodsCharged = targetPeriods;
        interestRemainingBeforePayment = Math.max(0, roundMoney(totalInterestDue - interestPaidPreviously));
        principalRemainingBeforePayment = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidPreviously));
        balance = roundMoney(principalRemainingBeforePayment + interestRemainingBeforePayment);
        totalDue = roundMoney(Number(loan.principal_amount) + totalInterestDue);
      }
    }
    if (payment > balance + 0.009) {
      throw new Error(`Repayment exceeds this loan's current total outstanding balance of ${balance.toLocaleString()} RWF.`);
    }

    // Split the cash actually received interest-first, then principal. This uses
    // the two remaining components and never rejects a valid payment because a
    // derived split accidentally exceeded the principal amount.
    if (!usesTrackedSplit) {
      interestRemainingBeforePayment = Math.min(interestRemainingBeforePayment, balance);
      principalRemainingBeforePayment = Math.max(0, roundMoney(balance - interestRemainingBeforePayment));
    }
    const allocation = allocateRepayment({
      payment,
      principalRemaining: principalRemainingBeforePayment,
      interestRemaining: interestRemainingBeforePayment,
    });
    const interestPaid = allocation.interestPaid;
    const principalPaid = allocation.principalPaid;
    const newBalance = allocation.balanceRemaining;
    const newStatus = newBalance < 0.01 ? "REPAID" : "ACTIVE";

    await connection.query(
      `UPDATE loans SET balance_remaining = ?, status = ?, total_interest_due = ?, total_amount_due = ?, interest_periods_charged = ? WHERE id = ?`,
      [newBalance, newStatus, totalInterestDue, totalDue, periodsCharged, parsedLoanId],
    );
    const [transactionResult] = await connection.query(
      `INSERT INTO transactions
        (group_id, cycle_id, meeting_id, member_id, loan_id, type, amount, principal_amount, interest_amount, shares_count)
       VALUES (?, ?, ?, ?, ?, 'LOAN_REPAYMENT', ?, ?, ?, 0)`,
      [parsedGroupId, parsedCycleId, parsedMeetingId, loan.member_id, parsedLoanId, payment, principalPaid, interestPaid],
    );

    if (principalPaid > 0) {
      await insertLedgerEntry(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        memberId: loan.member_id, loanId: parsedLoanId, fundType: "LOAN_FUND",
        entryType: "LOAN_PRINCIPAL_REPAYMENT", direction: "IN", amount: principalPaid,
        profitEffect: 0, notes: `Principal portion of repayment for loan #${parsedLoanId}.`,
        sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
        sourceComponent: "PRINCIPAL", createdBy: parsedCreatedBy,
      });
    }
    if (interestPaid > 0) {
      await insertLedgerEntry(connection, {
        groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
        memberId: loan.member_id, loanId: parsedLoanId, fundType: "LOAN_FUND",
        entryType: "LOAN_INTEREST_REPAYMENT", direction: "IN", amount: interestPaid,
        profitEffect: interestPaid, notes: `Interest/service-charge portion of repayment for loan #${parsedLoanId}.`,
        sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
        sourceComponent: "INTEREST", createdBy: parsedCreatedBy,
      });
      await connection.query(
        `UPDATE cycles SET total_interest_collected = COALESCE(total_interest_collected, 0) + ?
         WHERE id = ? AND group_id = ?`,
        [interestPaid, parsedCycleId, parsedGroupId],
      );
    }
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: Number(loan.member_id), sourceType: "TRANSACTION", sourceId: transactionResult.insertId,
      sourceComponent: "TOTAL", activityType: "LOAN_REPAYMENT", amount: payment,
      summary: `Repayment for loan #${parsedLoanId}`,
      details: { transactionId: transactionResult.insertId, loanId: parsedLoanId, principalPaid, interestPaid,
        interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
        balanceRemaining: newBalance, totalInterestDue, status: newStatus }, issuedBy: parsedCreatedBy,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_REPAID", entityType: "LOAN_REPAYMENT", entityId: transactionResult.insertId,
      beforeData: { balanceRemaining: balance, status: loan.status },
      afterData: { loanId: parsedLoanId, amount: payment, principalPaid, interestPaid, totalInterestDue,
        interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
        balanceRemaining: newBalance, status: newStatus, receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    await connection.commit();
    transactionStarted = false;
    return {
      loanId: parsedLoanId,
      repaymentAmount: payment,
      principalPaid,
      interestPaid,
      interestAccruedOnThisPayment: roundMoney(totalInterestDue - Number(loan.total_interest_due || 0)),
      totalInterestDue,
      balanceRemaining: newBalance,
      status: newStatus,
      meetingId: parsedMeetingId,
      transactionId: transactionResult.insertId,
      receipt,
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrappedError = new Error(`Repayment failed: ${error.message}`, { cause: error });
    wrappedError.code = error.code;
    wrappedError.sqlMessage = error.sqlMessage;
    wrappedError.sqlState = error.sqlState;
    throw wrappedError;
  } finally {
    connection.release();
  }
}


/** Lists a member's outstanding loans in the group's currently active cycle. */
async function getOutstandingLoans(groupId, cycleId, memberId) {
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedMemberId = requirePositiveInteger(memberId, "Borrower member ID");

  const [cycleRows] = await db.query(
    `SELECT id, cycle_number FROM cycles
     WHERE id = ? AND group_id = ? AND status = 'ACTIVE' LIMIT 1`,
    [parsedCycleId, parsedGroupId],
  );
  if (!cycleRows.length) {
    const error = new Error("The selected cycle is not active for this group.");
    error.statusCode = 400;
    throw error;
  }

  const [memberRows] = await db.query(
    `SELECT id FROM users WHERE id = ? AND group_id = ? LIMIT 1`,
    [parsedMemberId, parsedGroupId],
  );
  if (!memberRows.length) {
    const error = new Error("The selected borrower does not belong to this group.");
    error.statusCode = 404;
    throw error;
  }

  const [rows] = await db.query(
    `SELECT l.id, l.cycle_id, l.principal_amount, l.interest_rate, l.interest_method, l.interest_period_days,
        l.interest_periods_charged, l.total_interest_due, l.total_amount_due, l.balance_remaining,
        l.due_date, l.status, l.disbursed_at,
        COALESCE(r.principal_paid, 0) AS principal_paid_to_date,
        COALESCE(r.interest_paid, 0) AS interest_paid_to_date
     FROM loans l
     LEFT JOIN (
       SELECT loan_id, SUM(COALESCE(principal_amount, 0)) AS principal_paid, SUM(COALESCE(interest_amount, 0)) AS interest_paid
       FROM transactions WHERE type = 'LOAN_REPAYMENT' AND status = 'POSTED' AND loan_id IS NOT NULL GROUP BY loan_id
     ) r ON r.loan_id = l.id
     WHERE l.group_id = ? AND l.cycle_id = ? AND l.member_id = ?
       AND l.status = 'ACTIVE' AND l.balance_remaining > 0.009
     ORDER BY l.due_date ASC, l.disbursed_at ASC, l.id ASC`,
    [parsedGroupId, parsedCycleId, parsedMemberId],
  );

  return rows.map((loan) => {
    let projectedInterest = roundMoney(loan.total_interest_due);
    const method = String(loan.interest_method || "LEGACY_FIXED").toUpperCase();
    const principalPaidToDate = roundMoney(loan.principal_paid_to_date || 0);
    const interestPaidToDate = roundMoney(loan.interest_paid_to_date || 0);
    const principalBalanceBeforeProjection = Math.max(0, roundMoney(Number(loan.principal_amount) - principalPaidToDate));
    if (method === "FLAT_PER_PERIOD") {
      const periodDays = Number(loan.interest_period_days);
      const charged = Number(loan.interest_periods_charged || 0);
      if (Number.isSafeInteger(periodDays) && periodDays > 0) {
        const targetPeriods = periodicChargesDue({ now: Date.now(), disbursedAt: loan.disbursed_at, periodDays });
        const remainingPeriods = Math.max(0, targetPeriods - charged);
        if (remainingPeriods > 0 && principalBalanceBeforeProjection > 0) {
          const extra = calculateInterestOnRemainingPrincipal(principalBalanceBeforeProjection, Number(loan.interest_rate), remainingPeriods);
          projectedInterest = roundMoney(projectedInterest + extra);
        }
      }
    }
    const splitAvailable = ["FLAT_ONCE", "FLAT_PER_PERIOD"].includes(method);
    const interestBalanceRemaining = splitAvailable ? Math.max(0, roundMoney(projectedInterest - interestPaidToDate)) : null;
    const principalBalanceRemaining = splitAvailable ? principalBalanceBeforeProjection : null;
    const projectedTotalDue = roundMoney((principalBalanceRemaining ?? Number(loan.principal_amount)) + (interestBalanceRemaining ?? Math.max(0, projectedInterest - interestPaidToDate)));
    const projectedBalance = splitAvailable ? projectedTotalDue : roundMoney(loan.balance_remaining);
    // Do not invent a principal/interest split for loans issued before repayment components were tracked.
    // For new loans, the UI reflects stored balances plus any completed-but-not-yet-posted interest periods.
    return {
      loanId: Number(loan.id), cycleId: Number(loan.cycle_id), cycleNumber: Number(cycleRows[0].cycle_number),
      principalAmount: roundMoney(loan.principal_amount), principalBalanceRemaining, interestBalanceRemaining,
      totalInterestDue: projectedInterest, totalAmountDue: projectedTotalDue, balanceRemaining: projectedBalance,
      interestMethod: method, interestPeriodDays: loan.interest_period_days == null ? null : Number(loan.interest_period_days),
      dueDate: loan.due_date, status: loan.status, disbursedAt: loan.disbursed_at,
    };
  });
}

module.exports = { issueLoan, repayLoan, getOutstandingLoans };
