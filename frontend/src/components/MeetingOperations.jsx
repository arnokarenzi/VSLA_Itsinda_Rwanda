import { useCallback, useEffect, useMemo, useState } from "react";
import API from "../services/api";

function normalizeMeeting(meeting) {
  if (!meeting) return null;
  const id = Number(meeting.id ?? meeting.meetingId ?? meeting.meeting_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { ...meeting, id, meetingId: id, meetingNumber: Number(meeting.meetingNumber ?? meeting.meeting_number ?? 0), status: String(meeting.status || "OPEN").toUpperCase() };
}
function isAutomaticAbsenceFine(rule) {
  const label = String(rule?.label || rule?.name || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  return label === "absence without excuse" || label === "absent without excuse";
}
function money(value) { return `${Number(value || 0).toLocaleString()} RWF`; }

export default function MeetingOperations({ user, activeCycleId = null, onTransactionRecorded, onMeetingsChanged, onOpenCashbook }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [meetingNumber, setMeetingNumber] = useState("1");
  const [nextMeetingNumber, setNextMeetingNumber] = useState(1);
  const [activeMeeting, setActiveMeeting] = useState(null);
  const [openMeetings, setOpenMeetings] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [attendanceByMember, setAttendanceByMember] = useState({});
  const [summaryByMember, setSummaryByMember] = useState({});
  const [attendanceLoaded, setAttendanceLoaded] = useState(false);
  const [recordRefreshToken, setRecordRefreshToken] = useState(0);
  const [sharesCount, setSharesCount] = useState("0");
  const [shareValue, setShareValue] = useState(1000);
  const [socialFundAmount, setSocialFundAmount] = useState("");
  const [fineRuleSelection, setFineRuleSelection] = useState("");
  const [otherFineReason, setOtherFineReason] = useState("");
  const [otherFineAmount, setOtherFineAmount] = useState("");
  const [groupRules, setGroupRules] = useState({
    minSharesPerMeeting: 1, maxSharesPerMeeting: null, socialFundMode: "FLEXIBLE", socialFundContributionAmount: 0,
    fineRules: [], allowOtherFines: true, gusibuzaEnabled: false, gusibuzaFeeMode: "PER_SHARE", gusibuzaFeeAmount: 0,
  });
  const [gusibuzaInfo, setGusibuzaInfo] = useState(null);
  const [gusibuzaLoading, setGusibuzaLoading] = useState(false);
  const [targetMeetingId, setTargetMeetingId] = useState("");
  const [gusibuzaShares, setGusibuzaShares] = useState("1");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const presentMembers = useMemo(
    () => members.filter((member) => String(attendanceByMember[String(member.id)] || "").toUpperCase() === "PRESENT"),
    [members, attendanceByMember],
  );
  const selectedMemberAttendance = String(attendanceByMember[String(selectedMemberId)] || "NOT_RECORDED").toUpperCase();
  const selectedSummary = summaryByMember[String(selectedMemberId)] || {
    sharesCreditedForMeeting: 0, gusibuzaSharesBoughtNow: 0, socialFundPaid: 0, gusibuzaFeesPaid: 0, finesAssessed: 0, finesPaid: 0,
  };
  const selectedGusibuzaTarget = (gusibuzaInfo?.meetings || []).find((meeting) => String(meeting.meetingId) === String(targetMeetingId)) || null;
  const gusibuzaShareCount = Number(gusibuzaShares);
  const gusibuzaShareTotal = Number.isSafeInteger(gusibuzaShareCount) && gusibuzaShareCount > 0 ? gusibuzaShareCount * Number(gusibuzaInfo?.shareValue || shareValue) : 0;
  const gusibuzaFeePreview = !selectedGusibuzaTarget || !Number.isSafeInteger(gusibuzaShareCount) || gusibuzaShareCount <= 0
    ? 0
    : String(gusibuzaInfo?.feeMode).toUpperCase() === "PER_MEETING"
      ? (selectedGusibuzaTarget.feeAlreadyPaid ? 0 : Number(gusibuzaInfo?.feeAmount || 0))
      : Number(gusibuzaInfo?.feeAmount || 0) * gusibuzaShareCount;

  const loadOpenMeetings = useCallback(async ({ quiet = false } = {}) => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) {
      setOpenMeetings([]); setActiveMeeting(null); return [];
    }
    try {
      const response = await API.get(`/groups/${groupId}/meetings/open`, { params: { cycleId: activeCycleId } });
      const meetings = (response.data.success ? response.data.meetings || [] : []).map(normalizeMeeting).filter(Boolean);
      const suggestion = Number(response.data.nextMeetingNumber || 1);
      const safeSuggestion = Number.isSafeInteger(suggestion) && suggestion > 0 ? suggestion : 1;
      setNextMeetingNumber(safeSuggestion);
      if (!meetings.length) setMeetingNumber((current) => {
        const entered = Number(current);
        return !current || !Number.isSafeInteger(entered) || entered < safeSuggestion ? String(safeSuggestion) : current;
      });
      setOpenMeetings(meetings);
      setActiveMeeting((current) => current && meetings.some((meeting) => meeting.id === current.id)
        ? meetings.find((meeting) => meeting.id === current.id) || null : meetings[0] || null);
      return meetings;
    } catch (err) {
      if (!quiet) setMessage({ type: "error", text: err.response?.data?.message || "Could not load open meeting sessions." });
      setOpenMeetings([]); setActiveMeeting(null); return [];
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    let isMounted = true;
    const fetchInitialData = async () => {
      try {
        const [membersRes, groupRes] = await Promise.all([API.get(`/groups/${groupId}/members`), API.get(`/groups/${groupId}`)]);
        if (!isMounted) return;
        if (membersRes.data.success) setMembers((membersRes.data.members || []).filter((member) => member.is_active == null || Number(member.is_active) !== 0));
        if (groupRes.data.success && groupRes.data.group?.settings) {
          let settings = groupRes.data.group.settings;
          if (typeof settings === "string") { try { settings = JSON.parse(settings); } catch { settings = {}; } }
          if (Number.isFinite(Number(settings.shareValue)) && Number(settings.shareValue) > 0) setShareValue(Number(settings.shareValue));
          setGroupRules({
            minSharesPerMeeting: Number.isSafeInteger(Number(settings.minSharesPerMeeting)) && Number(settings.minSharesPerMeeting) >= 0 ? Number(settings.minSharesPerMeeting) : 1,
            maxSharesPerMeeting: settings.maxSharesPerMeeting == null || settings.maxSharesPerMeeting === "" ? null : Number(settings.maxSharesPerMeeting),
            socialFundMode: String(settings.socialFundMode || "FLEXIBLE").toUpperCase(),
            socialFundContributionAmount: Number(settings.socialFundContributionAmount || 0),
            fineRules: Array.isArray(settings.fineRules) ? settings.fineRules : [],
            allowOtherFines: settings.allowOtherFines !== false,
            gusibuzaEnabled: settings.gusibuzaEnabled === true,
            gusibuzaFeeMode: String(settings.gusibuzaFeeMode || "PER_SHARE").toUpperCase(),
            gusibuzaFeeAmount: Number(settings.gusibuzaFeeAmount || 0),
          });
        }
      } catch {
        if (isMounted) setMessage({ type: "error", text: "Failed to load group members or settings." });
      }
    };
    if (Number.isSafeInteger(groupId) && groupId > 0) void fetchInitialData();
    return () => { isMounted = false; };
  }, [groupId]);

  useEffect(() => {
    const schedule = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback) => setTimeout(callback, 0);
    const cancel = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : clearTimeout;
    const requestId = schedule(() => { void loadOpenMeetings({ quiet: true }); });
    return () => cancel(requestId);
  }, [loadOpenMeetings]);

  const refreshMeetingRecord = useCallback(async () => {
    if (!groupId || !activeCycleId || !activeMeeting?.id) {
      setAttendanceByMember({}); setSummaryByMember({}); setAttendanceLoaded(false); return;
    }
    setAttendanceLoaded(false);
    try {
      const response = await API.get(`/groups/${groupId}/meetings/${activeMeeting.id}/record`, { params: { cycleId: Number(activeCycleId) } });
      const rows = response.data?.record?.attendance || [];
      const statuses = {};
      const summaries = {};
      for (const row of rows) {
        statuses[String(row.memberId)] = String(row.status || "NOT_RECORDED").toUpperCase();
        summaries[String(row.memberId)] = row.summary || {};
      }
      setAttendanceByMember(statuses);
      setSummaryByMember(summaries);
    } catch (err) {
      setAttendanceByMember({}); setSummaryByMember({});
      setMessage({ type: "error", text: err.response?.data?.message || "Could not load attendance and member contribution summaries. Record attendance first." });
    } finally { setAttendanceLoaded(true); }
  }, [groupId, activeCycleId, activeMeeting?.id]);
  useEffect(() => { void refreshMeetingRecord(); }, [refreshMeetingRecord, recordRefreshToken]);

  useEffect(() => {
    if (!attendanceLoaded) return;
    if (presentMembers.length === 0) {
      if (selectedMemberId) setSelectedMemberId("");
      return;
    }
    if (!presentMembers.some((member) => String(member.id) === String(selectedMemberId))) setSelectedMemberId(String(presentMembers[0].id));
  }, [attendanceLoaded, presentMembers, selectedMemberId]);

  const loadGusibuzaOptions = useCallback(async () => {
    if (!groupRules.gusibuzaEnabled || !activeMeeting?.id || !activeCycleId || !selectedMemberId || selectedMemberAttendance !== "PRESENT") {
      setGusibuzaInfo(null); setTargetMeetingId(""); return;
    }
    setGusibuzaLoading(true);
    try {
      const response = await API.get(`/groups/${groupId}/gusibuza/eligible-meetings`, {
        params: { cycleId: Number(activeCycleId), currentMeetingId: Number(activeMeeting.id), memberId: Number(selectedMemberId) },
      });
      const payload = response.data || {};
      setGusibuzaInfo(payload);
      setTargetMeetingId((current) => (payload.meetings || []).some((meeting) => String(meeting.meetingId) === String(current))
        ? String(current) : payload.meetings?.length ? String(payload.meetings[0].meetingId) : "");
    } catch (err) {
      setGusibuzaInfo(null); setTargetMeetingId("");
      setMessage({ type: "error", text: err.response?.data?.message || "Could not load eligible gusibuza meetings." });
    } finally { setGusibuzaLoading(false); }
  }, [groupId, activeCycleId, activeMeeting?.id, selectedMemberId, selectedMemberAttendance, groupRules.gusibuzaEnabled]);
  useEffect(() => { void loadGusibuzaOptions(); }, [loadGusibuzaOptions, recordRefreshToken]);

  const handleOpenMeeting = async (event) => {
    event.preventDefault();
    if (!Number.isSafeInteger(Number(meetingNumber)) || Number(meetingNumber) <= 0) { setMessage({ type: "error", text: "Enter a valid positive meeting number." }); return; }
    setLoading(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/meetings`, { cycleId: Number(activeCycleId), meetingNumber: Number(meetingNumber), date: new Date().toISOString().split("T")[0] });
      if (!response.data.success) throw new Error(response.data.message || "Failed to open meeting.");
      const meeting = normalizeMeeting(response.data.meeting);
      if (!meeting) throw new Error("The server did not return a valid meeting ID. Refresh the meeting list and try again.");
      setActiveMeeting(meeting); setOpenMeetings([meeting]);
      setMessage({ type: "success", text: `Meeting #${meeting.meetingNumber} opened. Record attendance before selecting members.` });
      setRecordRefreshToken((value) => value + 1);
      if (onMeetingsChanged) onMeetingsChanged();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to open meeting." });
      await loadOpenMeetings({ quiet: true });
    } finally { setLoading(false); }
  };

  const handleRecordTransactions = async (event) => {
    event.preventDefault();
    const meetingId = Number(activeMeeting?.id ?? activeMeeting?.meetingId);
    if (!Number.isSafeInteger(meetingId) || meetingId <= 0) { setMessage({ type: "error", text: "No valid meeting session is open. Resume or open a meeting before recording transactions." }); return; }
    if (!selectedMemberId || selectedMemberAttendance !== "PRESENT") { setMessage({ type: "error", text: "Select a member marked Present in the attendance register." }); return; }
    const transactions = [];
    if (String(sharesCount).trim() !== "" && Number(sharesCount) > 0) transactions.push({ type: "SHARE_PURCHASE", amount: Number(sharesCount) * shareValue, sharesCount: Number(sharesCount) });
    if (String(socialFundAmount).trim() !== "" && Number(socialFundAmount) > 0) transactions.push({ type: "SOCIAL_FUND", amount: Number(socialFundAmount), sharesCount: 0 });
    let fineAssessment = null;
    if (fineRuleSelection) {
      fineAssessment = { ruleLabel: fineRuleSelection };
      if (fineRuleSelection === "OTHER") { fineAssessment.otherReason = otherFineReason; fineAssessment.otherAmount = Number(otherFineAmount); }
    }
    if (transactions.length === 0 && !fineAssessment) { setMessage({ type: "error", text: "Enter a contribution or select a fine rule to assess." }); return; }
    if (fineRuleSelection === "OTHER" && (String(otherFineReason).trim().length < 3 || !Number.isFinite(Number(otherFineAmount)) || Number(otherFineAmount) <= 0)) {
      setMessage({ type: "error", text: "For Other fine, enter a reason of at least 3 characters and a positive fine amount." }); return;
    }
    const recordedMemberId = String(selectedMemberId);
    setLoading(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/meetings/${meetingId}/transactions`, { groupId, cycleId: Number(activeCycleId), memberId: Number(selectedMemberId), transactions, fineAssessment });
      if (!response.data.success) throw new Error(response.data.message || "Failed to record transactions.");
      const member = presentMembers.find((entry) => String(entry.id) === recordedMemberId);
      const receiptNumbers = (response.data.transactions || []).map((item) => item.receipt?.receiptNumber).filter(Boolean);
      const assessedFine = response.data.fineAssessment;
      setMessage({ type: "success", text: `${transactions.length ? `Transactions recorded for ${member?.full_name || "the selected member"}. ` : ""}${receiptNumbers.length ? `Receipt(s): ${receiptNumbers.join(", ")}. ` : ""}${assessedFine ? `Fine assessed: ${assessedFine.fineLabel}${assessedFine.reason !== assessedFine.fineLabel ? ` (${assessedFine.reason})` : ""}, ${money(assessedFine.amount)} added to outstanding fines; no cash is recorded until it is paid. ` : ""}The meeting remains open.` });
      setSharesCount("0"); setSocialFundAmount(""); setFineRuleSelection(""); setOtherFineReason(""); setOtherFineAmount("");
      if (presentMembers.length) {
        const index = presentMembers.findIndex((entry) => String(entry.id) === recordedMemberId);
        setSelectedMemberId(String(presentMembers[(index + 1 + presentMembers.length) % presentMembers.length].id));
      }
      setRecordRefreshToken((value) => value + 1);
      if (onTransactionRecorded) await onTransactionRecorded();
    } catch (err) { setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to record transactions." }); }
    finally { setLoading(false); }
  };

  const handleRecordGusibuza = async (event) => {
    event.preventDefault();
    if (!activeMeeting?.id || !selectedMemberId || selectedMemberAttendance !== "PRESENT" || !selectedGusibuzaTarget) {
      setMessage({ type: "error", text: "Select a present member and an eligible earlier meeting for gusibuza." }); return;
    }
    if (!Number.isSafeInteger(gusibuzaShareCount) || gusibuzaShareCount <= 0 || gusibuzaShareCount > selectedGusibuzaTarget.sharesRemaining) {
      setMessage({ type: "error", text: `Enter between 1 and ${selectedGusibuzaTarget.sharesRemaining} late shares.` }); return;
    }
    setLoading(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/meetings/${activeMeeting.id}/gusibuza`, {
        groupId, cycleId: Number(activeCycleId), memberId: Number(selectedMemberId), targetMeetingId: selectedGusibuzaTarget.meetingId, sharesCount: gusibuzaShareCount,
      });
      if (!response.data.success) throw new Error(response.data.message || "Could not record gusibuza.");
      const result = response.data.gusibuza;
      setMessage({ type: "success", text: `${result.sharesCount} late share(s) credited to Meeting #${result.targetMeetingNumber}. Share value: ${money(result.shareTotal)}; gusibuza fee: ${money(result.fee)}. Receipt: ${result.shareReceipt?.receiptNumber || "issued"}${result.feeReceipt ? `; fee receipt: ${result.feeReceipt.receiptNumber}` : ""}.` });
      setGusibuzaShares("1"); setRecordRefreshToken((value) => value + 1);
      if (onTransactionRecorded) await onTransactionRecorded();
    } catch (err) { setMessage({ type: "error", text: err.response?.data?.message || err.message || "Could not record gusibuza." }); }
    finally { setLoading(false); }
  };

  const handleCloseMeeting = async () => {
    const meetingId = Number(activeMeeting?.id);
    if (!Number.isSafeInteger(meetingId) || meetingId <= 0) return;
    const closedNumber = Number(activeMeeting.meetingNumber || meetingNumber || 1);
    setLoading(true); setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/meetings/${meetingId}/close`, { cycleId: Number(activeCycleId) });
      if (!response.data.success) throw new Error(response.data.message || "Failed to close meeting.");
      const remaining = await loadOpenMeetings({ quiet: true });
      if (!remaining.length) setMeetingNumber(String(nextMeetingNumber > closedNumber ? nextMeetingNumber : closedNumber + 1));
      setMessage({ type: "success", text: response.data.message || `Meeting #${closedNumber} closed.` });
      if (onMeetingsChanged) onMeetingsChanged();
    } catch (err) { setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to close meeting." }); }
    finally { setLoading(false); }
  };

  const manualFineRules = groupRules.fineRules.filter((rule) => !isAutomaticAbsenceFine(rule));

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-6">
      <h2 className="text-xl font-bold text-gray-800 border-b pb-3">Meeting Operations &amp; Contributions</h2>
      {message.text && <div className={`p-3 rounded-lg text-sm ${message.type === "error" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>{message.text}</div>}
      {!activeMeeting ? (
        <form onSubmit={handleOpenMeeting} className="space-y-4 max-w-md">
          {openMeetings.length > 0 && <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">An open meeting already exists. Refresh the meeting list to resume it before opening another meeting. <button type="button" onClick={() => void loadOpenMeetings()} className="underline font-semibold">Refresh meetings</button></div>}
          <div><label className="block text-sm font-medium text-gray-700">Meeting Number</label><input type="number" required min="1" value={meetingNumber} onChange={(event) => setMeetingNumber(event.target.value)} placeholder="e.g. 1" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /></div>
          <button type="submit" disabled={loading || openMeetings.length > 0 || !activeCycleId} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">{loading ? "Opening..." : "Open Meeting Session"}</button>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="p-3 bg-blue-50 text-blue-800 rounded-lg text-sm space-y-2"><div className="flex justify-between items-center gap-3"><span><strong>Active Session:</strong> Meeting #{activeMeeting.meetingNumber} (ID: {activeMeeting.id})</span><span className="text-xs bg-blue-200 px-2 py-1 rounded">Open</span></div>
            {openMeetings.length > 1 && <div><label className="block text-xs font-medium mb-1">More than one meeting was already open</label><select value={String(activeMeeting.id)} onChange={(event) => { const chosen = openMeetings.find((meeting) => String(meeting.id) === event.target.value); if (chosen) setActiveMeeting(chosen); }} className="w-full bg-white border border-blue-200 rounded-lg px-3 py-2 text-slate-800">{openMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>Meeting #{meeting.meetingNumber} (ID: {meeting.id})</option>)}</select><p className="mt-1 text-xs">Finish and close these legacy overlapping sessions one at a time.</p></div>}
          </div>

          {!attendanceLoaded ? <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">Loading attendance and member summaries…</p> : presentMembers.length === 0 ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">No members are marked Present for this meeting. Open <strong>Meeting Records &amp; Attendance</strong>, mark each member Present, Absent or Excused (with a reason for Excused), and save the register first.</p> : (
            <form onSubmit={handleRecordTransactions} className="space-y-4 max-w-3xl">
              <div><label className="block text-sm font-medium text-gray-700">Select Present Member</label><select required value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg">{presentMembers.map((member) => <option key={member.id} value={member.id}>{member.full_name} ({member.phone_number})</option>)}</select></div>
              <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 space-y-2"><h3 className="font-bold text-blue-950">Selected member's contribution summary — Meeting #{activeMeeting.meetingNumber}</h3><div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm"><div><p className="text-blue-700">Shares credited to this meeting</p><p className="font-bold text-blue-950">{Number(selectedSummary.sharesCreditedForMeeting || 0)} share(s)</p></div><div><p className="text-blue-700">Late shares bought now</p><p className="font-bold text-blue-950">{Number(selectedSummary.gusibuzaSharesBoughtNow || 0)} share(s)</p></div><div><p className="text-blue-700">Social Fund paid</p><p className="font-bold text-blue-950">{money(selectedSummary.socialFundPaid)}</p></div><div><p className="text-blue-700">Fines assessed</p><p className="font-bold text-blue-950">{money(selectedSummary.finesAssessed)}</p></div><div><p className="text-blue-700">Fines paid</p><p className="font-bold text-blue-950">{money(selectedSummary.finesPaid)}</p></div><div><p className="text-blue-700">Fines outstanding</p><p className="font-bold text-blue-950">{money(Math.max(0, Number(selectedSummary.finesAssessed || 0) - Number(selectedSummary.finesPaid || 0)))}</p></div></div><p className="text-xs text-blue-800">Attendance: Present. This summary updates after each recorded transaction.</p></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-gray-700">Shares Purchased (Value: {shareValue.toLocaleString()} RWF / share)</label><input type="number" min="0" step="1" value={sharesCount} onChange={(event) => setSharesCount(event.target.value)} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /><span className="text-xs text-gray-500">Constitution minimum: {groupRules.minSharesPerMeeting}; already credited: {Number(selectedSummary.sharesCreditedForMeeting || 0)}. Current entry total: {(Number(sharesCount) * shareValue).toLocaleString()} RWF.</span></div>
                <div><label className="block text-sm font-medium text-gray-700">Social Fund Contribution (RWF)</label><input type="number" min="0" step="0.01" value={socialFundAmount} onChange={(event) => setSocialFundAmount(event.target.value)} placeholder={groupRules.socialFundMode === "FIXED" ? `${groupRules.socialFundContributionAmount} if unpaid` : "Contribution amount"} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" />{groupRules.socialFundMode === "FIXED" && <span className="text-xs text-gray-600">Fixed rule: total must equal exactly {groupRules.socialFundContributionAmount.toLocaleString()} RWF. Already paid: {money(selectedSummary.socialFundPaid)}. If already paid, leave blank.</span>}</div>
                <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3"><div><label className="block text-sm font-medium text-amber-950">Assess a Fine (optional)</label><select value={fineRuleSelection} onChange={(event) => setFineRuleSelection(event.target.value)} className="w-full px-3 py-2 mt-1 border border-amber-300 rounded-lg bg-white"><option value="">No fine</option>{manualFineRules.map((rule) => <option key={rule.label || rule.name} value={rule.label || rule.name}>{rule.label || rule.name} — {Number(rule.amount).toLocaleString()} RWF</option>)}{groupRules.allowOtherFines && <option value="OTHER">Other — enter reason and amount</option>}</select></div>
                  {fineRuleSelection && fineRuleSelection !== "OTHER" && (() => { const rule = manualFineRules.find((item) => String(item.label || item.name) === fineRuleSelection); return <p className="text-sm text-amber-900">The approved amount is <strong>{money(rule?.amount)}</strong>. This adds an outstanding fine; no cash is recorded until paid.</p>; })()}
                  {fineRuleSelection === "OTHER" && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="block text-sm font-medium text-gray-700">Reason for other fine</label><input required minLength="3" maxLength="255" value={otherFineReason} onChange={(event) => setOtherFineReason(event.target.value)} placeholder="Explain the reason" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /></div><div><label className="block text-sm font-medium text-gray-700">Fine amount (RWF)</label><input required type="number" min="0.01" step="0.01" value={otherFineAmount} onChange={(event) => setOtherFineAmount(event.target.value)} placeholder="Amount for this case" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /></div><p className="sm:col-span-2 text-xs text-amber-900">Other fines create an outstanding fine, not a cash receipt. Absence without excuse is automatic at meeting close and is not selectable here.</p></div>}
                </div>
              </div>
              <button type="submit" disabled={loading || presentMembers.length === 0} className="px-6 py-2 font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">{loading ? "Recording..." : "Record Member Transactions"}</button>
              <p className="text-xs text-slate-500">Absent and excused members do not appear in this list. After a successful save, the meeting remains open and the summary refreshes.</p>
            </form>
          )}

          {groupRules.gusibuzaEnabled && attendanceLoaded && selectedMemberId && selectedMemberAttendance === "PRESENT" && <section className="rounded-xl border border-violet-200 bg-violet-50 p-4 space-y-3"><div><h3 className="font-bold text-violet-950">Gusibuza — Buy shares for a previous meeting</h3><p className="mt-1 text-sm text-violet-900">Only prior closed meetings below the maximum share count are shown. These shares are credited to the selected previous meeting, and the fee follows the approved constitution.</p></div>
            {gusibuzaLoading ? <p className="text-sm text-violet-900">Loading eligible meetings…</p> : !(gusibuzaInfo?.meetings || []).length ? <p className="text-sm text-violet-900">{gusibuzaInfo?.message || "No earlier closed meetings have remaining share capacity for this member."}</p> : <form onSubmit={handleRecordGusibuza} className="grid grid-cols-1 md:grid-cols-2 gap-3"><div className="md:col-span-2"><label className="block text-sm font-medium text-violet-950">Meeting to credit</label><select required value={targetMeetingId} onChange={(event) => setTargetMeetingId(event.target.value)} className="mt-1 w-full rounded-lg border border-violet-300 bg-white px-3 py-2">{gusibuzaInfo.meetings.map((meeting) => <option key={meeting.meetingId} value={meeting.meetingId}>Meeting #{meeting.meetingNumber} — {meeting.sharesPaid}/{gusibuzaInfo.maxSharesPerMeeting} shares paid; {meeting.sharesRemaining} remaining{meeting.feeAlreadyPaid && gusibuzaInfo.feeMode === "PER_MEETING" ? "; fixed fee already paid" : ""}</option>)}</select></div><div><label className="block text-sm font-medium text-violet-950">Late shares to buy</label><input type="number" required min="1" max={selectedGusibuzaTarget?.sharesRemaining || 1} step="1" value={gusibuzaShares} onChange={(event) => setGusibuzaShares(event.target.value)} className="mt-1 w-full rounded-lg border border-violet-300 bg-white px-3 py-2" /><p className="mt-1 text-xs text-violet-900">Maximum for selected meeting: {selectedGusibuzaTarget?.sharesRemaining || 0}</p></div><div className="rounded-lg bg-white/70 p-3 text-sm text-violet-950"><p>Share payment: <strong>{money(gusibuzaShareTotal)}</strong></p><p>Gusibuza fee ({gusibuzaInfo.feeMode === "PER_MEETING" ? "per missed meeting" : "per share"}): <strong>{money(gusibuzaFeePreview)}</strong></p><p>Total due: <strong>{money(gusibuzaShareTotal + gusibuzaFeePreview)}</strong></p></div><button type="submit" disabled={loading || !selectedGusibuzaTarget} className="md:col-span-2 rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white hover:bg-violet-800 disabled:opacity-50">{loading ? "Recording…" : "Record Gusibuza Share Purchase"}</button></form>}
          </section>}

          <div className="border-t pt-4 space-y-2"><h3 className="font-semibold text-slate-800">Close this meeting</h3><p className="text-sm text-slate-600">Before closing, mark all active members Present, Absent or Excused (a reason is required for Excused). Members marked Absent automatically receive the constitution's absence fine at close. If the Social Fund is fixed, every present member must have paid exactly the required amount. Then count both funds with this meeting selected and resolve any variance.</p><div className="flex flex-wrap gap-2">{onOpenCashbook && <button type="button" onClick={onOpenCashbook} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50">Open Cashbook &amp; Reconciliation</button>}<button type="button" onClick={handleCloseMeeting} disabled={loading} className="px-4 py-2 rounded-lg font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50">{loading ? "Please wait..." : `Close Meeting #${activeMeeting.meetingNumber}`}</button></div></div>
        </div>
      )}
    </div>
  );
}
