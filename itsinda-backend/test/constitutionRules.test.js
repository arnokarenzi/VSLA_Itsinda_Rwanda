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

test("constitution allows a zero minimum share count", () => {
  const terms = normalizeConstitution({ ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, maxSharesPerMeeting: 0 });
  assert.equal(terms.minSharesPerMeeting, 0);
  assert.equal(terms.maxSharesPerMeeting, 0);
  assert.throws(() => normalizeConstitution({ ...DEFAULT_CONSTITUTION, minSharesPerMeeting: -1 }), /Minimum shares/);
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
  assert.equal(terms.interestMethod, "FLAT_PER_PERIOD");
  assert.equal(terms.interestPeriodDays, 180);
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
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 2 }, attendanceStatus: "PRESENT", sharePurchases: [{ sharesCount: 1 }] }), /at least 2 share/);
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 3 }, attendanceStatus: "PRESENT", existingSharesThisMeeting: 2, sharePurchases: [{ sharesCount: 2 }] }), /exceed the constitution's limit/);
  assert.equal(validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, maxSharesPerMeeting: 3 }, attendanceStatus: "PRESENT", existingSharesThisMeeting: 1, sharePurchases: [{ sharesCount: 2 }] }).totalSharesThisMeeting, 3);
});

test("meeting contribution rules enforce no-social and fixed-social policies", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "NONE" }, attendanceStatus: "PRESENT", socialFundTransactions: [{ amount: 100 }] }), /does not allow Social Fund/);
  assert.throws(() => validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FIXED", socialFundContributionAmount: 1000 }, attendanceStatus: "PRESENT", existingSocialFundAmount: 700, socialFundTransactions: [{ amount: 400 }] }), /must contribute exactly 1,000/);
  assert.equal(validateMeetingContributions({ terms: { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FIXED", socialFundContributionAmount: 1000 }, attendanceStatus: "PRESENT", existingSocialFundAmount: 500, socialFundTransactions: [{ amount: 500 }] }).totalSocialFundThisMeeting, 1000);
});

test("meeting contribution rules require approved fine types and amounts when configured", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, fineRules: [{ label: "Late arrival", amount: 500 }], allowOtherFines: false };
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", fineTransactions: [{ fineReason: "Absence", amount: 1000 }] }), /not listed in the group constitution/);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", fineTransactions: [{ fineReason: "Late arrival", amount: 1000 }] }), /does not match/);
  assert.equal(validateMeetingContributions({ terms, attendanceStatus: "PRESENT", fineTransactions: [{ fineReason: "Late arrival", amount: 500 }] }).requestedShares, 0);
});


test("fixed Social Fund requires the exact amount from present members", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FIXED", socialFundContributionAmount: 100 };
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", sharePurchases: [{ sharesCount: 1 }], socialFundTransactions: [] }), /must contribute exactly 100 RWF/);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", sharePurchases: [{ sharesCount: 1 }], socialFundTransactions: [{ amount: 50 }] }), /must contribute exactly 100 RWF/);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", sharePurchases: [{ sharesCount: 1 }], socialFundTransactions: [{ amount: 150 }] }), /must contribute exactly 100 RWF/);
  assert.equal(validateMeetingContributions({ terms, attendanceStatus: "PRESENT", sharePurchases: [{ sharesCount: 1 }], socialFundTransactions: [{ amount: 100 }] }).totalSocialFundThisMeeting, 100);
});

test("absent and excused members are exempt from Social Fund but cannot record meeting transactions", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FIXED", socialFundContributionAmount: 100 };
  assert.equal(validateMeetingContributions({ terms, attendanceStatus: "ABSENT" }).requestedSocialFund, 0);
  assert.equal(validateMeetingContributions({ terms, attendanceStatus: "EXCUSED" }).requestedSocialFund, 0);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "ABSENT", sharePurchases: [{ sharesCount: 1 }] }), /Only members marked Present/);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "EXCUSED", socialFundTransactions: [{ amount: 100 }] }), /Only members marked Present/);
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: null, sharePurchases: [{ sharesCount: 1 }], socialFundTransactions: [{ amount: 100 }] }), /Only members marked Present/);
});

test("minimum shares is enforced for present members when contribution activity is recorded", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 1, socialFundMode: "FLEXIBLE" };
  assert.throws(() => validateMeetingContributions({ terms, socialFundTransactions: [{ amount: 100 }], attendanceStatus: "PRESENT" }), /requires at least 1 share/);
  assert.throws(() => validateMeetingContributions({ terms, socialFundTransactions: [{ amount: 100 }], attendanceStatus: "ABSENT" }), /Only members marked Present/);
  assert.equal(validateMeetingContributions({ terms, existingSharesThisMeeting: 1, socialFundTransactions: [{ amount: 100 }], attendanceStatus: "PRESENT" }).totalSharesThisMeeting, 1);
  assert.equal(validateMeetingContributions({ terms: { ...terms, minSharesPerMeeting: 0 }, socialFundTransactions: [{ amount: 100 }], attendanceStatus: "PRESENT" }).totalSharesThisMeeting, 0);
});

test("fixed Social Fund cannot be bypassed by recording only a fine for a present member", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 0, socialFundMode: "FIXED", socialFundContributionAmount: 100 };
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", hasFineAssessment: true }), /must contribute exactly 100 RWF/);
  assert.doesNotThrow(() => validateMeetingContributions({ terms, attendanceStatus: "PRESENT", existingSocialFundAmount: 100, hasFineAssessment: true }));
  assert.throws(() => validateMeetingContributions({ terms, attendanceStatus: "ABSENT", hasFineAssessment: true }), /Only members marked Present/);
});

test("meeting closure requires exact fixed Social Fund from each present active member and recorded attendance", () => {
  const { validateFixedSocialFundMeetingClosure } = require("../services/constitutionRules");
  const terms = { socialFundMode: "FIXED", socialFundContributionAmount: 100 };
  assert.throws(() => validateFixedSocialFundMeetingClosure(terms, [
    { full_name: "Alice", attendance_status: "PRESENT", social_fund_paid: 0 },
  ]), /every present member must pay exactly 100 RWF/);
  assert.throws(() => validateFixedSocialFundMeetingClosure(terms, [
    { full_name: "Alice", attendance_status: "NOT_RECORDED", social_fund_paid: 0 },
  ]), /attendance must be marked/);
  assert.deepEqual(validateFixedSocialFundMeetingClosure(terms, [
    { full_name: "Alice", attendance_status: "PRESENT", social_fund_paid: 100 },
    { full_name: "Bob", attendance_status: "ABSENT", social_fund_paid: 0 },
    { full_name: "Chris", attendance_status: "EXCUSED", social_fund_paid: 0 },
  ]), { enforced: true, presentMembers: 1, requiredAmount: 100 });
  assert.deepEqual(validateFixedSocialFundMeetingClosure({ socialFundMode: "FLEXIBLE" }, []), { enforced: false, presentMembers: 0 });
});

test("fine assessment uses approved amounts and only allows custom amount for Other", () => {
  const { resolveFineAssessment } = require("../services/constitutionRules");
  const settings = { fineRules: [{ label: "Late arrival", amount: 500 }], allowOtherFines: true };
  assert.deepEqual(resolveFineAssessment(settings, { ruleLabel: "Late arrival", otherAmount: 9999 }), { fineLabel: "Late arrival", reason: "Late arrival", amount: 500 });
  assert.deepEqual(resolveFineAssessment(settings, { ruleLabel: "OTHER", otherReason: "Damaged group property", otherAmount: 750 }), { fineLabel: "Other", reason: "Damaged group property", amount: 750 });
  assert.throws(() => resolveFineAssessment({ ...settings, allowOtherFines: false }, { ruleLabel: "OTHER", otherReason: "Damaged property", otherAmount: 750 }), /does not allow/);
  assert.throws(() => resolveFineAssessment(settings, { ruleLabel: "Unknown" }), /not in the current approved constitution/);
});

test("fine assessment does not itself trigger the minimum share-purchase check", () => {
  const { validateMeetingContributions } = require("../services/constitutionRules");
  const terms = { ...DEFAULT_CONSTITUTION, minSharesPerMeeting: 1, socialFundMode: "FLEXIBLE", fineRules: [{ label: "Late arrival", amount: 500 }], allowOtherFines: false };
  assert.equal(validateMeetingContributions({ terms, attendanceStatus: "PRESENT", fineTransactions: [{ fineReason: "Late arrival", amount: 500 }] }).requestedShares, 0);
});
