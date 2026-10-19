import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const EMPTY_FORM = {
  shareValue: "1000",
  minSharesPerMeeting: "1",
  maxSharesPerMeeting: "",
  loanRatioLimit: "3",
  monthlyInterestPercent: "5",
  interestMethod: "FLAT_PER_PERIOD",
  interestPeriodDays: "30",
  gusibuzaEnabled: false,
  gusibuzaFeeMode: "PER_SHARE",
  gusibuzaFeeAmount: "100",
  socialFundMode: "FLEXIBLE",
  socialFundContributionAmount: "0",
  fineRulesText: "",
  allowOtherFines: true,
  meetingFrequency: "WEEKLY",
  meetingIntervalDays: "7",
  cycleDurationMonths: "12",
  withdrawalPolicy: "Document the group's approved process for voluntary withdrawal, settlement of outstanding obligations, and repayment of any member balance before withdrawal.",
  defaultPolicy: "Document the group's approved procedure for late repayment, missed instalments, member contact, restructuring, and group-approved action for default.",
};

function formFromTerms(terms = {}) {
  return {
    shareValue: String(terms.shareValue ?? 1000),
    minSharesPerMeeting: String(terms.minSharesPerMeeting ?? 1),
    maxSharesPerMeeting: terms.maxSharesPerMeeting == null ? "" : String(terms.maxSharesPerMeeting),
    loanRatioLimit: String(terms.loanRatioLimit ?? 3),
    monthlyInterestPercent: String(Number(terms.interestRate ?? terms.monthlyInterestRate ?? 0.05) * 100),
    interestMethod: terms.interestMethod === "FLAT_PER_MONTH" ? "FLAT_PER_PERIOD" : (terms.interestMethod || "FLAT_PER_PERIOD"),
    interestPeriodDays: String(terms.interestPeriodDays ?? terms.maxLoanTermDays ?? (Number(terms.maxLoanDurationMonths ?? 1) * 30)),
    gusibuzaEnabled: terms.gusibuzaEnabled === true,
    gusibuzaFeeMode: terms.gusibuzaFeeMode || "PER_SHARE",
    gusibuzaFeeAmount: String(terms.gusibuzaFeeAmount ?? 100),
    socialFundMode: terms.socialFundMode || "FLEXIBLE",
    socialFundContributionAmount: String(terms.socialFundContributionAmount ?? 0),
    fineRulesText: (Array.isArray(terms.fineRules) ? terms.fineRules : []).map((rule) => `${rule.label ?? rule.name}=${rule.amount}`).join("\n"),
    allowOtherFines: terms.allowOtherFines !== false,
    meetingFrequency: terms.meetingFrequency || "WEEKLY",
    meetingIntervalDays: String(terms.meetingIntervalDays ?? 7),
    cycleDurationMonths: String(terms.cycleDurationMonths ?? 12),
    withdrawalPolicy: terms.withdrawalPolicy || EMPTY_FORM.withdrawalPolicy,
    defaultPolicy: terms.defaultPolicy || EMPTY_FORM.defaultPolicy,
  };
}

function parseFineRules(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    const separator = line.lastIndexOf("=");
    if (separator < 1) throw new Error(`Fine rule line ${index + 1} must use the format: Reason=Amount (for example, Late arrival=500).`);
    const label = line.slice(0, separator).trim();
    const amountText = line.slice(separator + 1).trim().replaceAll(",", "");
    const amount = Number(amountText);
    if (!label || !Number.isFinite(amount) || amount <= 0) throw new Error(`Fine rule line ${index + 1} needs a reason and positive amount.`);
    return { label, amount };
  });
}

function termsFromForm(form) {
  return {
    shareValue: Number(form.shareValue),
    minSharesPerMeeting: Number(form.minSharesPerMeeting),
    maxSharesPerMeeting: form.maxSharesPerMeeting.trim() === "" ? null : Number(form.maxSharesPerMeeting),
    loanRatioLimit: Number(form.loanRatioLimit),
    monthlyInterestRate: Number(form.monthlyInterestPercent) / 100,
    interestRate: Number(form.monthlyInterestPercent) / 100,
    interestMethod: form.interestMethod,
    interestPeriodDays: Number(form.interestPeriodDays),
    maxLoanTermDays: Number(form.interestPeriodDays),
    gusibuzaEnabled: Boolean(form.gusibuzaEnabled),
    gusibuzaFeeMode: form.gusibuzaFeeMode,
    gusibuzaFeeAmount: Number(form.gusibuzaFeeAmount || 0),
    socialFundMode: form.socialFundMode,
    socialFundContributionAmount: Number(form.socialFundContributionAmount || 0),
    fineRules: parseFineRules(form.fineRulesText),
    allowOtherFines: Boolean(form.allowOtherFines),
    meetingFrequency: form.meetingFrequency,
    meetingIntervalDays: Number(form.meetingIntervalDays),
    cycleDurationMonths: Number(form.cycleDurationMonths),
    withdrawalPolicy: form.withdrawalPolicy,
    defaultPolicy: form.defaultPolicy,
  };
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString()} RWF` : "—";
}

function Field({ label, help, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-semibold text-slate-700">{label}</span>
      {children}
      {help && <span className="block text-xs text-slate-500">{help}</span>}
    </label>
  );
}

const inputClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500";

export default function ConstitutionManagement({ user }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const isLeadership = LEADERSHIP_ROLES.includes(String(user?.role || "").toUpperCase());
  const [snapshot, setSnapshot] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [voting, setVoting] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const fetchConstitution = useCallback(async ({ quiet = false } = {}) => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      setMessage({ type: "error", text: "Your account does not contain a valid group ID. Sign out and sign in again." });
      setLoading(false);
      return;
    }
    if (!quiet) setLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/constitution`);
      const data = response.data.constitution;
      setSnapshot(data);
      if (!data?.pending) {
        setForm(formFromTerms(data?.current?.terms || {}));
      }
      if (!quiet) setMessage({ type: "", text: "" });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not load group constitution. Confirm the Priority 3 database migration has been applied." });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [groupId]);

  useEffect(() => { void fetchConstitution(); }, [fetchConstitution]);

  const current = snapshot?.current;
  const terms = current?.terms || {};
  const pending = snapshot?.pending;
  const currentFineRules = useMemo(() => Array.isArray(terms.fineRules) ? terms.fineRules : [], [terms.fineRules]);

  const updateForm = (key, value) => setForm((previous) => ({ ...previous, [key]: value }));
  const handleFrequencyChange = (value) => {
    const intervals = { WEEKLY: "7", FORTNIGHTLY: "14", MONTHLY: "30" };
    setForm((previous) => ({ ...previous, meetingFrequency: value, meetingIntervalDays: intervals[value] || previous.meetingIntervalDays }));
  };

  const handleProposal = async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const proposedTerms = termsFromForm(form);
      const response = await API.post(`/groups/${groupId}/constitution/proposals`, { terms: proposedTerms, reason });
      setReason("");
      setMessage({ type: "success", text: response.data.message || "Proposal submitted for member voting." });
      await fetchConstitution({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || error.message || "Could not submit constitution proposal." });
    } finally {
      setSaving(false);
    }
  };

  const handleVote = async (vote) => {
    if (!pending) return;
    setVoting(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/constitution/proposals/${pending.id}/votes`, { vote });
      setMessage({ type: "success", text: response.data.message || "Vote recorded." });
      await fetchConstitution({ quiet: true });
    } catch (error) {
      setMessage({ type: "error", text: error.response?.data?.message || "Could not record your vote." });
    } finally {
      setVoting(false);
    }
  };

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading group constitution…</div>;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-slate-900">Group Constitution &amp; Rules</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">These rules belong to the group. Leadership may propose changes, but a proposal becomes active only after approval by a majority of all currently active users in the group.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${current?.approvalMethod === "MEMBER_VOTE" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
            {current?.approvalMethod === "MEMBER_VOTE" ? `Member-approved v${current?.versionNumber}` : `Interim legacy rules v${current?.versionNumber}`}
          </span>
        </div>

        {snapshot?.legacyWarning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <strong>Review needed:</strong> the displayed rules were imported from the settings your group already used. They have not been ratified through a member vote in this feature. Review them with the group and submit a proposal for formal approval. Existing loans and historical transactions are not changed by ratifying rules.
          </div>
        )}

        {message.text && <div className={`rounded-lg border p-3 text-sm ${message.type === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}`}>{message.text}</div>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Share price</p><p className="mt-1 font-bold text-slate-900">{money(terms.shareValue)}</p><p className="mt-1 text-xs text-slate-500">Minimum {terms.minSharesPerMeeting ?? 1} share(s) per member per meeting; maximum {terms.maxSharesPerMeeting == null ? "no configured cap" : `${terms.maxSharesPerMeeting} share(s)`}.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Borrowing limit</p><p className="mt-1 font-bold text-slate-900">{terms.loanRatioLimit ?? 3}× savings</p><p className="mt-1 text-xs text-slate-500">Maximum initial term: {terms.maxLoanTermDays ?? terms.interestPeriodDays ?? (Number(terms.maxLoanDurationMonths ?? 1) * 30)} days.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Interest/service charge</p><p className="mt-1 font-bold text-slate-900">{(Number(terms.interestRate ?? terms.monthlyInterestRate ?? 0.05) * 100).toLocaleString()}% {terms.interestMethod === "FLAT_ONCE" ? "once per loan" : `per ${terms.interestPeriodDays ?? terms.maxLoanTermDays ?? 30} days on remaining principal`}</p><p className="mt-1 text-xs text-slate-500">The expected date is set automatically from the approved period. Earlier or later repayments change interest accrual only for loans using the periodic method. Existing loans retain their recorded terms.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Social Fund</p><p className="mt-1 font-bold text-slate-900">{terms.socialFundMode === "NONE" ? "Not collected" : terms.socialFundMode === "FIXED" ? `${money(terms.socialFundContributionAmount)} per member/meeting` : "Flexible contributions"}</p><p className="mt-1 text-xs text-slate-500">Kept separate from the Loan Fund.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Gusibuza / late share purchase</p><p className="mt-1 font-bold text-slate-900">{terms.gusibuzaEnabled ? `${terms.gusibuzaFeeMode === "PER_MEETING" ? "Fixed fee per missed meeting" : "Fee per late share"}: ${money(terms.gusibuzaFeeAmount)}` : "Not allowed"}</p><p className="mt-1 text-xs text-slate-500">Late shares are credited to the original closed meeting and cannot exceed that meeting&apos;s share limit.</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Meeting cadence</p><p className="mt-1 font-bold text-slate-900">{terms.meetingFrequency === "CUSTOM" ? `Every ${terms.meetingIntervalDays} days` : ({ WEEKLY: "Weekly", FORTNIGHTLY: "Every two weeks", MONTHLY: "Monthly" }[terms.meetingFrequency] || "Weekly")}</p><p className="mt-1 text-xs text-slate-500">Expected savings cycle: {terms.cycleDurationMonths ?? 12} month(s).</p></div>
          <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fine policy</p>{currentFineRules.length ? <ul className="mt-1 space-y-1 text-sm text-slate-800">{currentFineRules.map((rule, index) => <li key={`${rule.label}-${index}`}>{rule.label}: {money(rule.amount)}{["absence without excuse", "absent without excuse"].includes(String(rule.label || rule.name || "").toLocaleLowerCase()) ? " (assessed automatically when meeting closes)" : ""}</li>)}</ul> : <p className="mt-1 text-sm text-slate-700">No named fine amounts configured.</p>}<p className="mt-1 text-xs text-slate-500">{terms.allowOtherFines === false ? "Only listed fine types are accepted." : "Other fines may be recorded with a reason."}</p></div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-800">Member withdrawal policy</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{terms.withdrawalPolicy || "Not documented."}</p></div>
          <div className="rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-800">Loan default policy</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">{terms.defaultPolicy || "Not documented."}</p></div>
        </div>
      </section>

      {pending && (
        <section className="rounded-2xl border border-blue-200 bg-white p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="text-lg font-bold text-slate-900">Constitution proposal v{pending.versionNumber}</h2><p className="mt-1 text-sm text-slate-600">Reason: {pending.proposalReason}</p></div>
            <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-800">Awaiting member vote</span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-emerald-50 p-3"><p className="text-xl font-bold text-emerald-800">{pending.approvals}</p><p className="text-xs text-emerald-800">Approve</p></div>
            <div className="rounded-lg bg-rose-50 p-3"><p className="text-xl font-bold text-rose-800">{pending.rejections}</p><p className="text-xs text-rose-800">Reject</p></div>
            <div className="rounded-lg bg-slate-50 p-3"><p className="text-xl font-bold text-slate-900">{pending.votesRequired}</p><p className="text-xs text-slate-600">Votes needed</p></div>
          </div>
          <p className="text-sm text-slate-600">An approval or rejection requires a majority of all active group users ({pending.activeMembers} currently active). Until then, the current rules remain in force. Each member can vote once.</p>
          <div className="rounded-xl bg-slate-50 p-4 space-y-3">
            <h3 className="font-semibold text-slate-800">Full proposed rules</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
              <p><strong>Share price:</strong> {money(pending.terms.shareValue)}</p>
              <p><strong>Shares/member/meeting:</strong> minimum {pending.terms.minSharesPerMeeting}; maximum {pending.terms.maxSharesPerMeeting == null ? "no cap" : pending.terms.maxSharesPerMeeting}</p>
              <p><strong>Loan cap:</strong> {pending.terms.loanRatioLimit}× savings</p>
              <p><strong>Interest/service charge:</strong> {(Number(pending.terms.interestRate ?? pending.terms.monthlyInterestRate) * 100).toLocaleString()}% {pending.terms.interestMethod === "FLAT_ONCE" ? "once per loan" : `per ${pending.terms.interestPeriodDays || pending.terms.maxLoanTermDays || 30} days on outstanding principal`}</p>
              <p><strong>Maximum initial loan term:</strong> {pending.terms.maxLoanTermDays || pending.terms.interestPeriodDays || 30} days</p>
              <p><strong>Gusibuza:</strong> {pending.terms.gusibuzaEnabled ? `${pending.terms.gusibuzaFeeMode === "PER_MEETING" ? "fixed per missed meeting" : "per late share"} · ${money(pending.terms.gusibuzaFeeAmount)}` : "Not enabled"}</p>
              <p><strong>Social Fund:</strong> {pending.terms.socialFundMode === "FIXED" ? `${money(pending.terms.socialFundContributionAmount)} per member/meeting` : pending.terms.socialFundMode}</p>
              <p><strong>Meeting frequency:</strong> {pending.terms.meetingFrequency === "CUSTOM" ? `every ${pending.terms.meetingIntervalDays} days` : ({ WEEKLY: "weekly", FORTNIGHTLY: "every two weeks", MONTHLY: "monthly" }[pending.terms.meetingFrequency] || "weekly")}</p>
              <p><strong>Cycle duration:</strong> {pending.terms.cycleDurationMonths} months</p>
              <p><strong>Unlisted fines:</strong> {pending.terms.allowOtherFines ? "allowed with a reason" : "not allowed"}</p>
            </div>
            <div><strong className="text-sm">Fine schedule</strong>{Array.isArray(pending.terms.fineRules) && pending.terms.fineRules.length ? <ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{pending.terms.fineRules.map((rule, index) => <li key={`${rule.label}-${index}`}>{rule.label}: {money(rule.amount)}</li>)}</ul> : <p className="mt-1 text-sm text-slate-600">No named fine amounts are configured.</p>}</div>
            <div><strong className="text-sm">Withdrawal policy</strong><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{pending.terms.withdrawalPolicy}</p></div>
            <div><strong className="text-sm">Loan default policy</strong><p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{pending.terms.defaultPolicy}</p></div>
          </div>
          {pending.userVote ? <p className="rounded-lg bg-slate-100 p-3 text-sm font-medium text-slate-700">Your vote has been recorded: {pending.userVote}. It cannot be changed.</p> : <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void handleVote("APPROVE")} disabled={voting} className="rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{voting ? "Submitting…" : "Approve constitution"}</button><button type="button" onClick={() => void handleVote("REJECT")} disabled={voting} className="rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50">Reject proposal</button></div>}
        </section>
      )}

      {isLeadership && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="mb-5"><h2 className="text-lg font-bold text-slate-900">Propose Constitution Rules</h2><p className="mt-1 text-sm text-slate-600">Update the draft to match the rules agreed by the group. Submitting this form does not immediately change operating rules; active members must vote first.</p></div>
          {pending ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">There is already a pending proposal. Resolve it through member voting before creating another.</div> : (
            <form onSubmit={handleProposal} className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Price per share (RWF)"><input className={inputClass} type="number" min="1" step="0.01" required value={form.shareValue} onChange={(e) => updateForm("shareValue", e.target.value)} /></Field>
                <Field label="Minimum shares per member per meeting"><input className={inputClass} type="number" min="0" step="1" required value={form.minSharesPerMeeting} onChange={(e) => updateForm("minSharesPerMeeting", e.target.value)} /></Field>
                <Field label="Maximum shares per member per meeting" help="Leave blank for no configured maximum."><input className={inputClass} type="number" min="1" step="1" value={form.maxSharesPerMeeting} onChange={(e) => updateForm("maxSharesPerMeeting", e.target.value)} /></Field>
                <Field label="Loan limit (multiple of savings)"><input className={inputClass} type="number" min="0.1" max="100" step="0.1" required value={form.loanRatioLimit} onChange={(e) => updateForm("loanRatioLimit", e.target.value)} /></Field>
                <Field label="Interest/service charge (%)" help="Enter 5 for 5%, not 0.05. For periodic interest this percentage applies each set period (days) to the remaining principal; the one-time method charges it once per loan."><input className={inputClass} type="number" min="0" max="100" step="0.01" required value={form.monthlyInterestPercent} onChange={(e) => updateForm("monthlyInterestPercent", e.target.value)} /></Field>
                <Field label="Interest/service-charge method"><select className={inputClass} value={form.interestMethod} onChange={(e) => updateForm("interestMethod", e.target.value)}><option value="FLAT_ONCE">One-time flat rate per loan</option><option value="FLAT_PER_PERIOD">Flat rate for every set period (days)</option></select></Field>
                <Field label="Set period and maximum initial loan term (days)" help="This period determines the due date. Under the per-period method, interest accrues for each completed period on the remaining principal. A loan can still be repaid earlier or later."><input className={inputClass} type="number" min="1" max="3660" step="1" required value={form.interestPeriodDays} onChange={(e) => updateForm("interestPeriodDays", e.target.value)} /></Field>
                <Field label="Social Fund contribution rule"><select className={inputClass} value={form.socialFundMode} onChange={(e) => updateForm("socialFundMode", e.target.value)}><option value="NONE">No regular Social Fund contribution</option><option value="FLEXIBLE">Flexible amount</option><option value="FIXED">Fixed amount per member per meeting</option></select></Field>
                <Field label="Fixed Social Fund amount (RWF)" help="Required only when fixed amount is selected."><input className={inputClass} type="number" min="0" step="0.01" disabled={form.socialFundMode !== "FIXED"} required={form.socialFundMode === "FIXED"} value={form.socialFundContributionAmount} onChange={(e) => updateForm("socialFundContributionAmount", e.target.value)} /></Field>
                <Field label="Gusibuza / late share purchase"><select className={inputClass} value={form.gusibuzaEnabled ? "YES" : "NO"} onChange={(e) => updateForm("gusibuzaEnabled", e.target.value === "YES")}><option value="NO">Not allowed</option><option value="YES">Allowed under these rules</option></select></Field>
                <Field label="Gusibuza fee method"><select className={inputClass} value={form.gusibuzaFeeMode} onChange={(e) => updateForm("gusibuzaFeeMode", e.target.value)} disabled={!form.gusibuzaEnabled}><option value="PER_SHARE">Fee for each late share</option><option value="PER_MEETING">One fixed fee per missed meeting</option></select></Field>
                <Field label="Gusibuza fee (RWF)" help={form.gusibuzaFeeMode === "PER_MEETING" ? "Charged once per member for each target meeting, regardless of the number of late shares." : "Charged for each late share purchased."}><input className={inputClass} type="number" min="0.01" step="0.01" required={form.gusibuzaEnabled} disabled={!form.gusibuzaEnabled} value={form.gusibuzaFeeAmount} onChange={(e) => updateForm("gusibuzaFeeAmount", e.target.value)} /></Field>
                <Field label="Meeting frequency"><select className={inputClass} value={form.meetingFrequency} onChange={(e) => handleFrequencyChange(e.target.value)}><option value="WEEKLY">Weekly</option><option value="FORTNIGHTLY">Every two weeks</option><option value="MONTHLY">Monthly</option><option value="CUSTOM">Custom interval</option></select></Field>
                <Field label="Meeting interval (days)" help="Automatically set for weekly/fortnightly/monthly; editable for custom."><input className={inputClass} type="number" min="1" max="366" step="1" required disabled={form.meetingFrequency !== "CUSTOM"} value={form.meetingIntervalDays} onChange={(e) => updateForm("meetingIntervalDays", e.target.value)} /></Field>
                <Field label="Savings cycle duration (months)"><input className={inputClass} type="number" min="1" max="36" step="1" required value={form.cycleDurationMonths} onChange={(e) => updateForm("cycleDurationMonths", e.target.value)} /></Field>
              </div>
              <Field label="Fine rules" help="One per line in the format Reason=Amount, e.g. Late arrival=500. Known fines must be paid at the configured amount."><textarea className={`${inputClass} min-h-24`} value={form.fineRulesText} onChange={(e) => updateForm("fineRulesText", e.target.value)} placeholder={'Absence without excuse=1000\nLate arrival=500'} /></Field>
              <label className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm text-slate-700"><input className="mt-1" type="checkbox" checked={form.allowOtherFines} onChange={(e) => updateForm("allowOtherFines", e.target.checked)} /><span><strong>Allow other fines not listed above.</strong><span className="mt-1 block text-xs text-slate-500">If unticked, only named fine types in this constitution may be recorded.</span></span></label>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Field label="Member withdrawal policy"><textarea className={`${inputClass} min-h-32`} maxLength={3000} required value={form.withdrawalPolicy} onChange={(e) => updateForm("withdrawalPolicy", e.target.value)} /></Field>
                <Field label="Loan default and late repayment policy"><textarea className={`${inputClass} min-h-32`} maxLength={3000} required value={form.defaultPolicy} onChange={(e) => updateForm("defaultPolicy", e.target.value)} /></Field>
              </div>
              <Field label="Reason for this proposal" help="Explain the decision agreed or requested by the group. At least 10 characters."><textarea className={`${inputClass} min-h-20`} maxLength={1000} required minLength={10} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: Members agreed during the meeting on 18 October to change the share price…" /></Field>
              <button type="submit" disabled={saving} className="rounded-lg bg-emerald-600 px-5 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? "Submitting proposal…" : "Submit for member approval"}</button>
            </form>
          )}
        </section>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 className="text-lg font-bold text-slate-900">Constitution version history</h2>
        <p className="mt-1 text-sm text-slate-600">Earlier versions are retained for transparency. Approval of new rules affects future transactions only; historical financial entries and already-issued loan terms are not recalculated.</p>
        <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-3">Version</th><th className="p-3">Status</th><th className="p-3">Approval</th><th className="p-3">Reason / source</th><th className="p-3">Created</th></tr></thead><tbody className="divide-y divide-slate-100">{(snapshot?.history || []).map((entry) => <tr key={entry.id}><td className="p-3 font-semibold">v{entry.versionNumber}</td><td className="p-3">{entry.status}</td><td className="p-3">{entry.approvalMethod === "LEGACY_IMPORTED" ? "Legacy import" : "Member vote"}</td><td className="p-3 text-slate-600">{entry.proposalReason || "—"}</td><td className="p-3 text-slate-500">{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "—"}</td></tr>)}</tbody></table></div>
        <button type="button" onClick={() => void fetchConstitution()} className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">Refresh constitution</button>
      </section>
    </div>
  );
}
