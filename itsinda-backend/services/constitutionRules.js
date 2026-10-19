const DEFAULT_CONSTITUTION = Object.freeze({
  shareValue: 1000,
  minSharesPerMeeting: 1,
  maxSharesPerMeeting: null,
  loanRatioLimit: 3,
  monthlyInterestRate: 0.05,
  interestMethod: "FLAT_PER_MONTH",
  maxLoanDurationMonths: 12,
  socialFundMode: "FLEXIBLE",
  socialFundContributionAmount: 0,
  fineRules: [],
  allowOtherFines: true,
  meetingFrequency: "WEEKLY",
  meetingIntervalDays: 7,
  cycleDurationMonths: 12,
  withdrawalPolicy: "Document the group's approved process for voluntary withdrawal, settlement of outstanding obligations, and repayment of any member balance before withdrawal.",
  defaultPolicy: "Document the group's approved procedure for late repayment, missed instalments, member contact, restructuring, and group-approved action for default.",
});

const INTEREST_METHODS = new Set(["FLAT_PER_MONTH", "FLAT_ONCE"]);
const SOCIAL_FUND_MODES = new Set(["NONE", "FLEXIBLE", "FIXED"]);
const MEETING_FREQUENCIES = new Set(["WEEKLY", "FORTNIGHTLY", "MONTHLY", "CUSTOM"]);

function parseSettings(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      throw new Error("Group settings contain invalid JSON.");
    }
  }
  return {};
}

function finiteNumber(value, label, { min = 0, minExclusive = false, max = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (value == null || value === "" || !Number.isFinite(number) || (minExclusive ? number <= min : number < min) || number > max || (integer && !Number.isSafeInteger(number))) {
    const minimumText = minExclusive ? `greater than ${min}` : `at least ${min}`;
    const integerText = integer ? " whole number" : "";
    const maxText = Number.isFinite(max) ? ` and no more than ${max}` : "";
    throw new Error(`${label} must be a valid${integerText} ${minimumText}${maxText}.`);
  }
  return number;
}

function normalizeConstitution(input = {}, base = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Constitution terms must be an object.");
  const values = { ...DEFAULT_CONSTITUTION, ...base, ...input };
  const terms = {};

  terms.shareValue = finiteNumber(values.shareValue, "Share value", { min: 0, minExclusive: true, max: 100000000 });
  terms.minSharesPerMeeting = finiteNumber(values.minSharesPerMeeting, "Minimum shares per member per meeting", { min: 1, max: 10000, integer: true });
  if (values.maxSharesPerMeeting == null || values.maxSharesPerMeeting === "") {
    terms.maxSharesPerMeeting = null;
  } else {
    terms.maxSharesPerMeeting = finiteNumber(values.maxSharesPerMeeting, "Maximum shares per member per meeting", { min: 1, max: 10000, integer: true });
    if (terms.maxSharesPerMeeting < terms.minSharesPerMeeting) {
      throw new Error("Maximum shares per meeting cannot be less than the minimum shares per meeting.");
    }
  }
  terms.loanRatioLimit = finiteNumber(values.loanRatioLimit, "Loan-to-savings limit", { min: 0, minExclusive: true, max: 100 });
  terms.monthlyInterestRate = finiteNumber(values.monthlyInterestRate, "Interest/service-charge rate", { min: 0, max: 1 });
  terms.interestMethod = String(values.interestMethod || "FLAT_PER_MONTH").toUpperCase();
  if (!INTEREST_METHODS.has(terms.interestMethod)) throw new Error("Choose a supported interest calculation method.");
  terms.maxLoanDurationMonths = finiteNumber(values.maxLoanDurationMonths, "Maximum loan duration", { min: 1, max: 60, integer: true });

  terms.socialFundMode = String(values.socialFundMode || "FLEXIBLE").toUpperCase();
  if (!SOCIAL_FUND_MODES.has(terms.socialFundMode)) throw new Error("Choose a valid Social Fund contribution rule.");
  terms.socialFundContributionAmount = finiteNumber(values.socialFundContributionAmount ?? 0, "Social Fund contribution amount", { min: 0, max: 100000000 });
  if (terms.socialFundMode === "FIXED" && terms.socialFundContributionAmount <= 0) {
    throw new Error("A fixed Social Fund contribution must be greater than zero.");
  }

  if (!Array.isArray(values.fineRules)) throw new Error("Fine rules must be a list.");
  if (values.fineRules.length > 30) throw new Error("A maximum of 30 fine rules may be configured.");
  const fineNames = new Set();
  terms.fineRules = values.fineRules.map((rule, index) => {
    const label = String(rule?.label ?? rule?.name ?? "").trim().slice(0, 100);
    if (!label) throw new Error(`Fine rule ${index + 1} needs a name.`);
    const normalizedName = label.toLocaleLowerCase();
    if (fineNames.has(normalizedName)) throw new Error(`The fine rule "${label}" is duplicated.`);
    fineNames.add(normalizedName);
    return { label, amount: finiteNumber(rule?.amount, `Fine amount for "${label}"`, { min: 0, minExclusive: true, max: 100000000 }) };
  });
  if (typeof values.allowOtherFines !== "boolean") throw new Error("Allow-other-fines setting must be true or false.");
  terms.allowOtherFines = values.allowOtherFines;

  terms.meetingFrequency = String(values.meetingFrequency || "WEEKLY").toUpperCase();
  if (!MEETING_FREQUENCIES.has(terms.meetingFrequency)) throw new Error("Choose a valid meeting frequency.");
  const standardIntervals = { WEEKLY: 7, FORTNIGHTLY: 14, MONTHLY: 30 };
  terms.meetingIntervalDays = terms.meetingFrequency === "CUSTOM"
    ? finiteNumber(values.meetingIntervalDays, "Custom meeting interval", { min: 1, max: 366, integer: true })
    : standardIntervals[terms.meetingFrequency];
  terms.cycleDurationMonths = finiteNumber(values.cycleDurationMonths, "Savings cycle duration", { min: 1, max: 36, integer: true });

  const withdrawalPolicy = String(values.withdrawalPolicy ?? "").trim();
  const defaultPolicy = String(values.defaultPolicy ?? "").trim();
  if (withdrawalPolicy.length < 10) throw new Error("Withdrawal policy must contain at least 10 characters.");
  if (defaultPolicy.length < 10) throw new Error("Loan-default policy must contain at least 10 characters.");
  if (withdrawalPolicy.length > 3000 || defaultPolicy.length > 3000) throw new Error("Policy text cannot exceed 3,000 characters.");
  terms.withdrawalPolicy = withdrawalPolicy;
  terms.defaultPolicy = defaultPolicy;

  return terms;
}

function calculateInterestAmount(principalAmount, interestRate, durationMonths, interestMethod) {
  const principal = Number(principalAmount);
  const rate = Number(interestRate);
  const duration = Number(durationMonths);
  const method = String(interestMethod || "FLAT_PER_MONTH").toUpperCase();
  if (!Number.isFinite(principal) || principal < 0 || !Number.isFinite(rate) || rate < 0 || !Number.isSafeInteger(duration) || duration < 1 || !INTEREST_METHODS.has(method)) {
    throw new Error("Cannot calculate interest from invalid loan terms.");
  }
  const amount = principal * rate * (method === "FLAT_ONCE" ? 1 : duration);
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function validateMeetingContributions({
  terms: rawTerms = {},
  existingSharesThisMeeting = 0,
  sharePurchases = [],
  existingSocialFundAmount = 0,
  socialFundTransactions = [],
  fineTransactions = [],
} = {}) {
  const terms = { ...DEFAULT_CONSTITUTION, ...rawTerms };
  const minShares = Number(terms.minSharesPerMeeting ?? 1);
  const maxShares = terms.maxSharesPerMeeting == null || terms.maxSharesPerMeeting === "" ? null : Number(terms.maxSharesPerMeeting);
  const previousShares = Number(existingSharesThisMeeting || 0);
  if (!Number.isSafeInteger(minShares) || minShares < 1) throw new Error("The group's minimum-shares rule is invalid. Review its constitution.");
  if (!Number.isFinite(previousShares) || previousShares < 0) throw new Error("Existing meeting share totals are invalid.");
  if (maxShares !== null && (!Number.isSafeInteger(maxShares) || maxShares < minShares)) throw new Error("The group's maximum-shares rule is invalid. Review its constitution.");
  const requestedShares = sharePurchases.reduce((sum, item) => {
    const count = Number(item?.sharesCount);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Shares purchased must be a positive whole number.");
    return sum + count;
  }, 0);
  if (requestedShares > 0 && previousShares + requestedShares < minShares) {
    throw new Error(`The constitution requires at least ${minShares} share(s) per member per meeting when purchasing shares.`);
  }
  if (maxShares !== null && previousShares + requestedShares > maxShares) {
    throw new Error(`This member would exceed the constitution's limit of ${maxShares} share(s) in this meeting. Already recorded: ${previousShares}.`);
  }

  const socialMode = String(terms.socialFundMode || "FLEXIBLE").toUpperCase();
  const fixedSocialAmount = Number(terms.socialFundContributionAmount ?? 0);
  if (!["NONE", "FLEXIBLE", "FIXED"].includes(socialMode)) throw new Error("The group's Social Fund contribution rule is invalid. Review its constitution.");
  if (socialMode === "FIXED" && (!Number.isFinite(fixedSocialAmount) || fixedSocialAmount <= 0)) throw new Error("The fixed Social Fund contribution in the group's constitution is invalid.");
  const priorSocialAmount = Number(existingSocialFundAmount || 0);
  const requestedSocialAmount = socialFundTransactions.reduce((sum, item) => {
    const amount = Number(item?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("SOCIAL_FUND amount must be greater than zero.");
    return sum + amount;
  }, 0);
  if (requestedSocialAmount > 0 && socialMode === "NONE") throw new Error("The current group constitution does not allow Social Fund contributions.");
  if (requestedSocialAmount > 0 && socialMode === "FIXED" && priorSocialAmount + requestedSocialAmount > fixedSocialAmount + 0.009) {
    throw new Error(`The constitution sets the Social Fund contribution at ${fixedSocialAmount.toLocaleString()} RWF per member per meeting. Already recorded: ${priorSocialAmount.toLocaleString()} RWF.`);
  }

  const fineRules = Array.isArray(terms.fineRules) ? terms.fineRules : [];
  const allowOtherFines = typeof terms.allowOtherFines === "boolean" ? terms.allowOtherFines : true;
  for (const fine of fineTransactions) {
    const reason = String(fine?.fineReason || "General fine").trim();
    const amount = Number(fine?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("Fine amount must be greater than zero.");
    const matchingRule = fineRules.find((rule) => String(rule?.label ?? rule?.name ?? "").trim().toLocaleLowerCase() === reason.toLocaleLowerCase());
    if (!matchingRule && !allowOtherFines) {
      const available = fineRules.map((rule) => String(rule?.label ?? rule?.name ?? "")).filter(Boolean).join(", ");
      throw new Error(`This fine is not listed in the group constitution. Use an approved fine rule${available ? `: ${available}` : "; no fines are currently defined"}.`);
    }
    if (matchingRule) {
      const configuredAmount = Number(matchingRule.amount);
      if (!Number.isFinite(configuredAmount) || Math.abs(amount - configuredAmount) > 0.009) {
        throw new Error(`The constitution sets the fine for "${reason}" at ${Number(matchingRule.amount).toLocaleString()} RWF. The amount entered does not match.`);
      }
    }
  }

  return {
    requestedShares,
    totalSharesThisMeeting: previousShares + requestedShares,
    requestedSocialFund: requestedSocialAmount,
    totalSocialFundThisMeeting: priorSocialAmount + requestedSocialAmount,
  };
}

function majorityThreshold(activeMembers) {
  const count = Number(activeMembers);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("The group must have at least one active member to vote.");
  return Math.floor(count / 2) + 1;
}

function evaluateVoteOutcome({ activeMembers, approvals, rejections, totalVotes }) {
  const threshold = majorityThreshold(activeMembers);
  if (approvals >= threshold) return "CURRENT";
  if (rejections >= threshold) return "REJECTED";
  if (totalVotes >= activeMembers) return "DEADLOCKED";
  return "PENDING";
}

function getInitialConstitutionFromSettings(rawSettings) {
  const settings = parseSettings(rawSettings);
  return normalizeConstitution({
    ...DEFAULT_CONSTITUTION,
    ...settings,
    // Old group settings may store the rate under the legacy property. It is already a decimal fraction.
    monthlyInterestRate: settings.monthlyInterestRate ?? DEFAULT_CONSTITUTION.monthlyInterestRate,
    fineRules: Array.isArray(settings.fineRules) ? settings.fineRules : [],
    allowOtherFines: typeof settings.allowOtherFines === "boolean" ? settings.allowOtherFines : true,
    maxSharesPerMeeting: settings.maxSharesPerMeeting ?? null,
    socialFundMode: settings.socialFundMode ?? "FLEXIBLE",
    socialFundContributionAmount: settings.socialFundContributionAmount ?? 0,
  });
}

module.exports = {
  DEFAULT_CONSTITUTION,
  parseSettings,
  normalizeConstitution,
  majorityThreshold,
  evaluateVoteOutcome,
  calculateInterestAmount,
  validateMeetingContributions,
  getInitialConstitutionFromSettings,
};
