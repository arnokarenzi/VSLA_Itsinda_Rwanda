"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  periodicChargesDue,
  calculateInterestOnRemainingPrincipal,
  allocateRepayment,
} = require("../services/loanCalculations");

test("periodic loans include a charge immediately and another after each completed period", () => {
  const disbursedAt = "2026-01-01T00:00:00.000Z";
  const day3 = new Date("2026-01-04T00:00:00.000Z").getTime();
  const day30 = new Date("2026-01-31T00:00:00.000Z").getTime();
  const day32 = new Date("2026-02-02T00:00:00.000Z").getTime();
  assert.equal(periodicChargesDue({ now: day3, disbursedAt, periodDays: 30 }), 1);
  assert.equal(periodicChargesDue({ now: day30, disbursedAt, periodDays: 30 }), 2);
  assert.equal(periodicChargesDue({ now: day32, disbursedAt, periodDays: 30 }), 2);
});

test("periodic interest is reduced after a partial payment reduces remaining principal", () => {
  assert.equal(calculateInterestOnRemainingPrincipal(10000, 0.05, 1), 500);
  assert.equal(calculateInterestOnRemainingPrincipal(9000, 0.05, 1), 450);
  assert.equal(calculateInterestOnRemainingPrincipal(9000, 0.05, 2), 900);
});

test("repayment allocation applies received cash to interest and then remaining principal", () => {
  assert.deepEqual(allocateRepayment({ payment: 1000, principalRemaining: 9500, interestRemaining: 500 }), {
    interestPaid: 500, principalPaid: 500, balanceRemaining: 9000,
  });
});

test("repayment allocation never splits more principal than outstanding and gives a clear overpayment error", () => {
  assert.deepEqual(allocateRepayment({ payment: 250, principalRemaining: 100, interestRemaining: 300 }), {
    interestPaid: 250, principalPaid: 0, balanceRemaining: 150,
  });
  assert.throws(() => allocateRepayment({ payment: 501, principalRemaining: 100, interestRemaining: 400 }), /total outstanding loan balance/);
});
