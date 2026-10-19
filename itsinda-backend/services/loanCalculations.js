"use strict";

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * For FLAT_PER_PERIOD loans, the first service charge is due on disbursement.
 * Every completed period after disbursement adds one more charge. Thus a 30-day
 * period has one charge on day 3, and two charges on day 32.
 */
function periodicChargesDue({ now = Date.now(), disbursedAt, periodDays }) {
  const start = new Date(disbursedAt).getTime();
  const period = Number(periodDays);
  if (!Number.isFinite(start) || !Number.isSafeInteger(period) || period <= 0) {
    throw new Error("Loan disbursement date and interest period must be valid.");
  }
  const elapsedDays = Math.max(0, Math.floor((Number(now) - start) / 86400000));
  return 1 + Math.floor(elapsedDays / period);
}

/** Flat simple-interest charge(s) against the principal still unpaid. */
function calculateInterestOnRemainingPrincipal(principalRemaining, interestRate, periods = 1) {
  const principal = Number(principalRemaining);
  const rate = Number(interestRate);
  const count = Number(periods);
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 ||
      !Number.isSafeInteger(count) || count < 0) {
    throw new Error("Cannot calculate loan interest from invalid values.");
  }
  return roundMoney(principal * rate * count);
}

/**
 * Allocate actual cash received to outstanding interest first, then principal.
 * This is bounded by total outstanding components, so a payment can never be
 * split into more principal than the member actually owes.
 */
function allocateRepayment({ payment, principalRemaining, interestRemaining }) {
  const paid = roundMoney(payment);
  const principal = roundMoney(principalRemaining);
  const interest = roundMoney(interestRemaining);
  if (![paid, principal, interest].every(Number.isFinite) || paid <= 0 || principal < 0 || interest < 0) {
    throw new Error("Repayment amounts and outstanding balances must be valid non-negative amounts.");
  }
  const outstanding = roundMoney(principal + interest);
  if (paid > outstanding + 0.009) {
    throw new Error(`Repayment exceeds the total outstanding loan balance of ${outstanding.toLocaleString()} RWF.`);
  }
  const interestPaid = roundMoney(Math.min(paid, interest));
  const principalPaid = roundMoney(Math.min(Math.max(0, paid - interestPaid), principal));
  return { interestPaid, principalPaid, balanceRemaining: Math.max(0, roundMoney(outstanding - paid)) };
}

module.exports = { roundMoney, periodicChargesDue, calculateInterestOnRemainingPrincipal, allocateRepayment };
