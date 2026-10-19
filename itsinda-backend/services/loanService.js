const db = require("../config/db");
const { insertLedgerEntry, getBookBalance, requirePreviouslyBalancedCount, roundMoney } = require("./fundLedgerService");
const { createReceipt } = require("./receiptService");
const { writeAuditEvent } = require("./auditService");
const { calculateInterestAmount } = require("./constitutionRules");

// These fallback values are retained for older group records, but should eventually
// be replaced by constitution-approved settings stored for each group.
const DEFAULT_LOAN_SETTINGS = Object.freeze({
  shareValue: 1000,
  loanRatioLimit: 3,
  monthlyInterestRate: 0.05,
  interestMethod: "FLAT_PER_MONTH",
  maxLoanDurationMonths: 12,
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

/** Issues a loan and records the cash outflow atomically. */
async function issueLoan(
  groupId,
  cycleId,
  memberId,
  principalAmount,
  durationMonths,
  dueDate,
  meetingId,
  createdBy,
  auditMeta = {},
) {
  const parsedGroupId = requirePositiveInteger(groupId, "Group ID");
  const parsedCycleId = requirePositiveInteger(cycleId, "Cycle ID");
  const parsedMemberId = requirePositiveInteger(memberId, "Borrower member ID");
  const principal = requirePositiveAmount(principalAmount, "Principal amount");
  const duration = requirePositiveInteger(durationMonths, "Duration in months");
  const parsedDueDate = requireISODate(dueDate, "Due date");
  const parsedCreatedBy = requirePositiveInteger(createdBy, "Recording user ID");

  const connection = await db.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    // Locking the cycle serializes loan disbursement, expense and reconciliation operations.
    const [cycleRows] = await connection.query(
      `SELECT id FROM cycles WHERE id = ? AND group_id = ? AND status = 'ACTIVE' FOR UPDATE`,
      [parsedCycleId, parsedGroupId],
    );
    if (!cycleRows.length) throw new Error("The selected financial cycle is not active for this group.");
    const parsedMeetingId = await requireOpenMeeting(connection, meetingId, parsedGroupId, parsedCycleId);

    const [groupRows] = await connection.query("SELECT settings FROM `groups` WHERE id = ?", [parsedGroupId]);
    if (!groupRows.length) throw new Error("Group not found.");
    const settings = parseSettings(groupRows[0].settings);
    const shareValue = readNumericSetting(settings, "shareValue", { min: 0, exclusiveMin: true, max: 100000000 });
    const loanRatioLimit = readNumericSetting(settings, "loanRatioLimit", { min: 0, exclusiveMin: true, max: 100 });
    const monthlyInterestRate = readNumericSetting(settings, "monthlyInterestRate", { min: 0, max: 1 });
    const maxLoanDurationMonths = readNumericSetting(settings, "maxLoanDurationMonths", { min: 0, exclusiveMin: true, max: 60 });
    const interestMethod = String(settings.interestMethod || "FLAT_PER_MONTH").toUpperCase();
    if (!["FLAT_PER_MONTH", "FLAT_ONCE"].includes(interestMethod)) throw new Error("The group constitution has an unsupported interest calculation method.");
    if (!Number.isInteger(maxLoanDurationMonths)) throw new Error('Group loan setting "maxLoanDurationMonths" must be a positive integer.');
    if (duration > maxLoanDurationMonths) throw new Error(`Loan duration cannot exceed ${maxLoanDurationMonths} months.`);

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
    if (principal > maxBorrowLimit) {
      throw new Error(`Loan request exceeds the maximum allowed limit of ${maxBorrowLimit.toLocaleString()} RWF (based on ${loanRatioLimit}x savings).`);
    }

    await requirePreviouslyBalancedCount(connection, parsedGroupId, parsedCycleId, "LOAN_FUND");
    const cashAvailable = await getBookBalance(connection, parsedGroupId, parsedCycleId, "LOAN_FUND");
    if (principal > cashAvailable + 0.001) {
      throw new Error(`The loan fund has ${cashAvailable.toLocaleString()} RWF recorded as available cash, which is not enough to disburse ${principal.toLocaleString()} RWF. Reconcile the cashbook before proceeding.`);
    }

    const interest = calculateInterestAmount(principal, monthlyInterestRate, duration, interestMethod);
    const totalDue = roundMoney(principal + interest);
    if (![interest, totalDue].every(Number.isFinite)) throw new Error("Loan calculations produced an invalid amount.");

    const [loanResult] = await connection.query(
      `INSERT INTO loans
        (group_id, cycle_id, member_id, principal_amount, interest_rate,
         total_interest_due, total_amount_due, balance_remaining, due_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [parsedGroupId, parsedCycleId, parsedMemberId, principal, monthlyInterestRate, interest, totalDue, totalDue, parsedDueDate],
    );

    const ledgerEntryId = await insertLedgerEntry(connection, {
      groupId: parsedGroupId,
      cycleId: parsedCycleId,
      meetingId: parsedMeetingId,
      memberId: parsedMemberId,
      loanId: loanResult.insertId,
      fundType: "LOAN_FUND",
      entryType: "LOAN_DISBURSEMENT",
      direction: "OUT",
      amount: principal,
      profitEffect: 0,
      notes: `Loan #${loanResult.insertId} disbursed to member ${parsedMemberId}.`,
      sourceType: "LOAN",
      sourceId: loanResult.insertId,
      sourceComponent: "DISBURSEMENT",
      createdBy: parsedCreatedBy,
    });
    const receipt = await createReceipt(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      memberId: parsedMemberId, sourceType: "LOAN", sourceId: loanResult.insertId,
      sourceComponent: "DISBURSEMENT", activityType: "LOAN_DISBURSEMENT", amount: principal,
      summary: `Loan #${loanResult.insertId} disbursed`,
      details: { loanId: loanResult.insertId, ledgerEntryId, principalAmount: principal, interestRate: monthlyInterestRate,
        durationMonths: duration, interestMethod, totalInterestDue: interest, totalAmountDue: totalDue, dueDate: parsedDueDate },
      issuedBy: parsedCreatedBy,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_ISSUED", entityType: "LOAN", entityId: loanResult.insertId,
      afterData: { memberId: parsedMemberId, principalAmount: principal, interestRate: monthlyInterestRate,
        durationMonths: duration, interestMethod, totalInterestDue: interest, totalAmountDue: totalDue, dueDate: parsedDueDate,
        receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    await connection.commit();
    transactionStarted = false;
    return {
      loanId: loanResult.insertId,
      principalAmount: principal,
      interestRate: monthlyInterestRate,
      interestMethod,
      durationMonths: duration,
      totalInterestDue: interest,
      totalAmountDue: totalDue,
      balanceRemaining: totalDue,
      dueDate: parsedDueDate,
      meetingId: parsedMeetingId,
      receipt,
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => {});
    const wrappedError = new Error(`Loan issuance failed: ${error.message}`, { cause: error });
    wrappedError.code = error.code;
    wrappedError.sqlMessage = error.sqlMessage;
    wrappedError.sqlState = error.sqlState;
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
    const balance = roundMoney(loan.balance_remaining);
    if (payment > balance + 0.001) {
      throw new Error(`Repayment exceeds this loan's remaining balance of ${balance.toLocaleString()} RWF.`);
    }

    // Earlier app versions stored only the outstanding total. For those records,
    // the cumulative paid amount is reconstructed from total due minus remaining balance.
    // This implementation applies payments to interest first, then principal.
    const totalDue = roundMoney(loan.total_amount_due);
    const totalInterestDue = roundMoney(loan.total_interest_due);
    const previouslyPaid = Math.max(0, roundMoney(totalDue - balance));
    const interestPaidPreviously = Math.min(totalInterestDue, previouslyPaid);
    const interestRemainingBeforePayment = Math.max(0, roundMoney(totalInterestDue - interestPaidPreviously));
    const interestPaid = roundMoney(Math.min(payment, interestRemainingBeforePayment));
    const principalPaid = roundMoney(payment - interestPaid);
    const newBalance = Math.max(0, roundMoney(balance - payment));
    const newStatus = newBalance < 0.01 ? "REPAID" : "ACTIVE";

    await connection.query(
      "UPDATE loans SET balance_remaining = ?, status = ? WHERE id = ?",
      [newBalance, newStatus, parsedLoanId],
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
        balanceRemaining: newBalance, status: newStatus }, issuedBy: parsedCreatedBy,
    });
    await writeAuditEvent(connection, {
      groupId: parsedGroupId, cycleId: parsedCycleId, meetingId: parsedMeetingId,
      actorUserId: parsedCreatedBy, action: "LOAN_REPAID", entityType: "LOAN_REPAYMENT", entityId: transactionResult.insertId,
      beforeData: { balanceRemaining: balance, status: loan.status },
      afterData: { loanId: parsedLoanId, amount: payment, principalPaid, interestPaid, balanceRemaining: newBalance,
        status: newStatus, receiptNumber: receipt.receiptNumber }, ...auditMeta,
    });

    await connection.commit();
    transactionStarted = false;
    return {
      loanId: parsedLoanId,
      repaymentAmount: payment,
      principalPaid,
      interestPaid,
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
    `SELECT id, cycle_id, principal_amount, total_interest_due, total_amount_due,
        balance_remaining, due_date, status, disbursed_at
     FROM loans
     WHERE group_id = ? AND cycle_id = ? AND member_id = ?
       AND status = 'ACTIVE' AND balance_remaining > 0.009
     ORDER BY due_date ASC, disbursed_at ASC, id ASC`,
    [parsedGroupId, parsedCycleId, parsedMemberId],
  );

  return rows.map((loan) => ({
    loanId: Number(loan.id),
    cycleId: Number(loan.cycle_id),
    cycleNumber: Number(cycleRows[0].cycle_number),
    principalAmount: roundMoney(loan.principal_amount),
    totalInterestDue: roundMoney(loan.total_interest_due),
    totalAmountDue: roundMoney(loan.total_amount_due),
    balanceRemaining: roundMoney(loan.balance_remaining),
    dueDate: loan.due_date,
    status: loan.status,
    disbursedAt: loan.disbursed_at,
  }));
}

module.exports = { issueLoan, repayLoan, getOutstandingLoans };
