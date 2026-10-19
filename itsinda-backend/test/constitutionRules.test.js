const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_CONSTITUTION,
  normalizeConstitution,
  majorityThreshold,
  evaluateVoteOutcome,
  getInitialConstitutionFromSettings,
  calculateInterestAmount,
} = require("../services/constitutionRules");

test("constitution normalizer preserves backward-compatible rules and accepts unlimited shares", () => {
  const terms = normalizeConstitution({ ...DEFAULT_CONSTITUTION, shareValue: 1500, maxSharesPerMeeting: null });
  assert.equal(terms.shareValue, 1500);
  assert.equal(terms.maxSharesPerMeeting, null);
  assert.equal(terms.loanRatioLimit, 3);
  assert.equal(terms.monthlyInterestRate, 0.05);
});

test("constitution rejects a maximum share count below the minimum", () => {
  assert.throws(() => normalizeConstitution({ ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 3, maxSharesPerMeeting: 2 }), /cannot be less than the minimum/);
});

test("fixed Social Fund contribution requires a positive amount", () => {
  assert.throws(() => normalizeConstitution({ ...DEFAULT_CONSTITUTION, socialFundMode: "FIXED", socialFundContributionAmount: 0 }), /must be greater than zero/);
});

test("fine rules require unique labels and positive values", () => {
  assert.throws(() => normalizeConstitution({ ...DEFAULT_CONSTITUTION, fineRules: [{ label: "Late", amount: 500 }, { label: "late", amount: 1000 }] }), /duplicated/);
  assert.throws(() => normalizeConstitution({ ...DEFAULT_CONSTITUTION, fineRules: [{ label: "Absence", amount: 0 }] }), /must be a valid/);
});

test("legacy settings are imported without changing their existing loan terms", () => {
  const terms = getInitialConstitutionFromSettings(JSON.stringify({ shareValue: 2000, loanRatioLimit: 2, monthlyInterestRate: 0.04, maxLoanDurationMonths: 6 }));
  assert.equal(terms.shareValue, 2000);
  assert.equal(terms.loanRatioLimit, 2);
  assert.equal(terms.monthlyInterestRate, 0.04);
  assert.equal(terms.maxLoanDurationMonths, 6);
  assert.equal(terms.interestMethod, "FLAT_PER_MONTH");
});

test("member voting requires an absolute majority of active users", () => {
  assert.equal(majorityThreshold(4), 3);
  assert.equal(majorityThreshold(5), 3);
  assert.equal(evaluateVoteOutcome({ activeMembers: 5, approvals: 3, rejections: 1, totalVotes: 4 }), "CURRENT");
  assert.equal(evaluateVoteOutcome({ activeMembers: 5, approvals: 1, rejections: 3, totalVotes: 4 }), "REJECTED");
  assert.equal(evaluateVoteOutcome({ activeMembers: 4, approvals: 2, rejections: 2, totalVotes: 4 }), "DEADLOCKED");
});

test("interest calculation uses the approved method and rounds to cents", () => {
  assert.equal(calculateInterestAmount(10000, 0.05, 3, "FLAT_PER_MONTH"), 1500);
  assert.equal(calculateInterestAmount(10000, 0.05, 3, "FLAT_ONCE"), 500);
  assert.throws(() => calculateInterestAmount(10000, 0.05, 3, "UNKNOWN"), /invalid loan terms/);
});

test("meeting contribution rules enforce share minimum and per-meeting maximum", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 2 }, sharePurchases: [{ sharesCount: 1 }] }), /at least 2 share/);
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 3 }, existingSharesThisMeeting: 2, sharePurchases: [{ sharesCount: 2 }] }), /exceed the constitution's limit/);
  assert.equal(validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 3 }, existingSharesThisMeeting: 1, sharePurchases: [{ sharesCount: 2 }] }).totalSharesThisMeeting, 3);
});

test("meeting contribution rules enforce no-social and fixed-social policies", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, socialFundMode: "NONE" }, socialFundTransactions: [{ amount: 100 }] }), /does not allow Social Fund/);
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, socialFundMode: "FIXED", socialFundContributionAmount: 1000 }, existingSocialFundAmount: 700, socialFundTransactions: [{ amount: 400 }] }), /sets the Social Fund contribution at 1,000/);
  assert.equal(validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, socialFundMode: "FIXED", socialFundContributionAmount: 1000 }, existingSocialFundAmount: 500, socialFundTransactions: [{ amount: 500 }] }).totalSocialFundThisMeeting, 1000);
});

test("meeting contribution rules require approved fine types and amounts when configured", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, fineRules: [{ label: "Late arrival", amount: 500 }], allowOtherFines: false };
  assert.throws(() => validateMeetingContributions({ terms, fineTransactions: [{ fineReason: "Absence", amount: 1000 }] }), /not listed in the group constitution/);
  assert.throws(() => validateMeetingContributions({ terms, fineTransactions: [{ fineReason: "Late arrival", amount: 1000 }] }), /does not match/);
  assert.equal(validateMeetingContributions({ terms, fineTransactions: [{ fineReason: "Late arrival", amount: 500 }] }).requestedShares, 0);
});
