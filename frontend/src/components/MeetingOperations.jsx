import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

function normalizeMeeting(meeting) {
  if (!meeting) return null;
  const id = Number(meeting.id ?? meeting.meetingId ?? meeting.meeting_id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    ...meeting,
    id,
    meetingId: id,
    meetingNumber: Number(meeting.meetingNumber ?? meeting.meeting_number ?? 0),
    status: String(meeting.status || "OPEN").toUpperCase(),
  };
}

export default function MeetingOperations({ user, activeCycleId = null, onTransactionRecorded, onMeetingsChanged, onOpenCashbook }) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [meetingNumber, setMeetingNumber] = useState("1");
  const [nextMeetingNumber, setNextMeetingNumber] = useState(1);
  const [activeMeeting, setActiveMeeting] = useState(null);
  const [openMeetings, setOpenMeetings] = useState([]);
  const [members, setMembers] = useState([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [sharesCount, setSharesCount] = useState(0);
  const [shareValue, setShareValue] = useState(1000);
  const [socialFundAmount, setSocialFundAmount] = useState("");
  const [fineRuleSelection, setFineRuleSelection] = useState("");
  const [otherFineReason, setOtherFineReason] = useState("");
  const [otherFineAmount, setOtherFineAmount] = useState("");
  const [selectedMemberAttendance, setSelectedMemberAttendance] = useState("NOT_RECORDED");
  const [groupRules, setGroupRules] = useState({
    minSharesPerMeeting: 1,
    socialFundMode: "FLEXIBLE",
    socialFundContributionAmount: 0,
    fineRules: [],
    allowOtherFines: true,
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  const loadOpenMeetings = useCallback(async ({ quiet = false } = {}) => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) {
      setOpenMeetings([]);
      setActiveMeeting(null);
      return [];
    }
    try {
      const response = await API.get(`/groups/${groupId}/meetings/open`, { params: { cycleId: activeCycleId } });
      const meetings = (response.data.success ? response.data.meetings || [] : []).map(normalizeMeeting).filter(Boolean);
      const suggestion = Number(response.data.nextMeetingNumber || 1);
      const safeSuggestion = Number.isSafeInteger(suggestion) && suggestion > 0 ? suggestion : 1;
      setNextMeetingNumber(safeSuggestion);
      if (!meetings.length) {
        setMeetingNumber((current) => {
          const entered = Number(current);
          return !current || !Number.isSafeInteger(entered) || entered < safeSuggestion ? String(safeSuggestion) : current;
        });
      }
      setOpenMeetings(meetings);
      setActiveMeeting((current) => current && meetings.some((meeting) => meeting.id === current.id)
        ? meetings.find((meeting) => meeting.id === current.id) || null
        : meetings[0] || null);
      return meetings;
    } catch (err) {
      if (!quiet) setMessage({ type: "error", text: err.response?.data?.message || "Could not load open meeting sessions." });
      setOpenMeetings([]);
      setActiveMeeting(null);
      return [];
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    let isMounted = true;
    const fetchInitialData = async () => {
      try {
        const [membersRes, groupRes] = await Promise.all([
          API.get(`/groups/${groupId}/members`),
          API.get(`/groups/${groupId}`),
        ]);
        if (!isMounted) return;
        if (membersRes.data.success) {
          const activeMembers = (membersRes.data.members || []).filter((member) => member.is_active == null || Number(member.is_active) !== 0);
          setMembers(activeMembers);
          if (activeMembers.length) setSelectedMemberId(String(activeMembers[0].id));
        }
        if (groupRes.data.success && groupRes.data.group?.settings) {
          let settings = groupRes.data.group.settings;
          if (typeof settings === "string") {
            try { settings = JSON.parse(settings); } catch { settings = {}; }
          }
          if (Number.isFinite(Number(settings.shareValue)) && Number(settings.shareValue) > 0) setShareValue(Number(settings.shareValue));
          setGroupRules({
            minSharesPerMeeting: Number.isSafeInteger(Number(settings.minSharesPerMeeting)) && Number(settings.minSharesPerMeeting) >= 0 ? Number(settings.minSharesPerMeeting) : 1,
            socialFundMode: String(settings.socialFundMode || "FLEXIBLE").toUpperCase(),
            socialFundContributionAmount: Number(settings.socialFundContributionAmount || 0),
            fineRules: Array.isArray(settings.fineRules) ? settings.fineRules : [],
            allowOtherFines: settings.allowOtherFines !== false,
          });
        }
      } catch {
        if (isMounted) setMessage({ type: "error", text: "Failed to load group members or settings." });
      }
    };
    void fetchInitialData();
    return () => { isMounted = false; };
  }, [groupId]);

  useEffect(() => {
    const schedule = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    const cancel = typeof cancelAnimationFrame === "function"
      ? cancelAnimationFrame
      : clearTimeout;
    const requestId = schedule(() => { void loadOpenMeetings({ quiet: true }); });
    return () => cancel(requestId);
  }, [loadOpenMeetings]);

  useEffect(() => {
    let current = true;
    if (!activeMeeting?.id || !activeCycleId || !selectedMemberId) {
      setSelectedMemberAttendance("NOT_RECORDED");
      return () => { current = false; };
    }
    const fetchAttendance = async () => {
      try {
        const response = await API.get(`/groups/${groupId}/meetings/${activeMeeting.id}/record`, { params: { cycleId: Number(activeCycleId) } });
        const rows = response.data?.record?.attendance || [];
        const member = rows.find((row) => String(row.memberId) === String(selectedMemberId));
        if (current) setSelectedMemberAttendance(String(member?.status || "NOT_RECORDED").toUpperCase());
      } catch {
        if (current) setSelectedMemberAttendance("NOT_RECORDED");
      }
    };
    void fetchAttendance();
    return () => { current = false; };
  }, [groupId, activeMeeting?.id, activeCycleId, selectedMemberId]);

  const handleOpenMeeting = async (event) => {
    event.preventDefault();
    if (!Number.isSafeInteger(Number(meetingNumber)) || Number(meetingNumber) <= 0) {
      setMessage({ type: "error", text: "Enter a valid positive meeting number." });
      return;
    }
    setLoading(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/meetings`, {
        cycleId: Number(activeCycleId), meetingNumber: Number(meetingNumber), date: new Date().toISOString().split("T")[0],
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to open meeting.");
      const meeting = normalizeMeeting(response.data.meeting);
      if (!meeting) throw new Error("The server did not return a valid meeting ID. Refresh the meeting list and try again.");
      setActiveMeeting(meeting);
      setOpenMeetings([meeting]);
      setMessage({ type: "success", text: `Meeting #${meeting.meetingNumber} opened successfully. You can now record transactions for multiple members.` });
      if (onMeetingsChanged) onMeetingsChanged();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to open meeting." });
      await loadOpenMeetings({ quiet: true });
    } finally {
      setLoading(false);
    }
  };

  const handleRecordTransactions = async (event) => {
    event.preventDefault();
    const meetingId = Number(activeMeeting?.id ?? activeMeeting?.meetingId);
    if (!Number.isSafeInteger(meetingId) || meetingId <= 0) {
      setMessage({ type: "error", text: "No valid meeting session is open. Resume or open a meeting before recording transactions." });
      return;
    }
    if (!selectedMemberId) {
      setMessage({ type: "error", text: "Select a member before recording transactions." });
      return;
    }

    const transactions = [];
    if (String(sharesCount).trim() !== "" && Number(sharesCount) > 0) transactions.push({ type: "SHARE_PURCHASE", amount: Number(sharesCount) * shareValue, sharesCount: Number(sharesCount) });
    if (String(socialFundAmount).trim() !== "" && Number(socialFundAmount) > 0) transactions.push({ type: "SOCIAL_FUND", amount: Number(socialFundAmount), sharesCount: 0 });
    let fineAssessment = null;
    if (fineRuleSelection) {
      fineAssessment = { ruleLabel: fineRuleSelection };
      if (fineRuleSelection === "OTHER") {
        fineAssessment.otherReason = otherFineReason;
        fineAssessment.otherAmount = Number(otherFineAmount);
      }
    }
    if (transactions.length === 0 && !fineAssessment) {
      setMessage({ type: "error", text: "Enter a contribution or select a fine rule to assess." });
      return;
    }
    if (fineRuleSelection === "OTHER" && (String(otherFineReason).trim().length < 3 || !Number.isFinite(Number(otherFineAmount)) || Number(otherFineAmount) <= 0)) {
      setMessage({ type: "error", text: "For Other fine, enter a reason of at least 3 characters and a positive fine amount." });
      return;
    }

    const recordedMemberId = String(selectedMemberId);
    setLoading(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/meetings/${meetingId}/transactions`, {
        groupId, cycleId: Number(activeCycleId), memberId: Number(selectedMemberId), transactions, fineAssessment,
      });
      if (!response.data.success) throw new Error(response.data.message || "Failed to record transactions.");
      const member = members.find((entry) => String(entry.id) === recordedMemberId);
      const receiptNumbers = (response.data.transactions || []).map((item) => item.receipt?.receiptNumber).filter(Boolean);
      const assessedFine = response.data.fineAssessment;
      setMessage({ type: "success", text: `${transactions.length ? `Transactions recorded for ${member?.full_name || "the selected member"}. ` : ""}${receiptNumbers.length ? `Receipt(s): ${receiptNumbers.join(", ")}. ` : ""}${assessedFine ? `Fine assessed: ${assessedFine.fineLabel}${assessedFine.reason !== assessedFine.fineLabel ? ` (${assessedFine.reason})` : ""}, ${Number(assessedFine.amount).toLocaleString()} RWF added to outstanding fines; no cash is recorded until it is paid. ` : ""}The meeting remains open.` });
      setSharesCount(0);
      setSocialFundAmount("");
      setFineRuleSelection("");
      setOtherFineReason("");
      setOtherFineAmount("");
      if (members.length) {
        const index = members.findIndex((entry) => String(entry.id) === recordedMemberId);
        setSelectedMemberId(String(members[(index + 1 + members.length) % members.length].id));
      }
      if (onTransactionRecorded) await onTransactionRecorded();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to record transactions." });
    } finally {
      setLoading(false);
    }
  };

  const handleCloseMeeting = async () => {
    const meetingId = Number(activeMeeting?.id);
    if (!Number.isSafeInteger(meetingId) || meetingId <= 0) return;
    const closedNumber = Number(activeMeeting.meetingNumber || meetingNumber || 1);
    setLoading(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await API.post(`/groups/${groupId}/meetings/${meetingId}/close`, { cycleId: Number(activeCycleId) });
      if (!response.data.success) throw new Error(response.data.message || "Failed to close meeting.");
      const remaining = await loadOpenMeetings({ quiet: true });
      if (!remaining.length) setMeetingNumber(String(nextMeetingNumber > closedNumber ? nextMeetingNumber : closedNumber + 1));
      setMessage({ type: "success", text: response.data.message || `Meeting #${closedNumber} closed.` });
      if (onMeetingsChanged) onMeetingsChanged();
    } catch (err) {
      setMessage({ type: "error", text: err.response?.data?.message || err.message || "Failed to close meeting." });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-6">
      <h2 className="text-xl font-bold text-gray-800 border-b pb-3">Meeting Operations &amp; Contributions</h2>
      {message.text && <div className={`p-3 rounded-lg text-sm ${message.type === "error" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>{message.text}</div>}

      {!activeMeeting ? (
        <form onSubmit={handleOpenMeeting} className="space-y-4 max-w-md">
          {openMeetings.length > 0 && <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">An open meeting already exists. Refresh the meeting list to resume it before opening another meeting. <button type="button" onClick={() => void loadOpenMeetings()} className="underline font-semibold">Refresh meetings</button></div>}
          <div>
            <label className="block text-sm font-medium text-gray-700">Meeting Number</label>
            <input type="number" required min="1" value={meetingNumber} onChange={(event) => setMeetingNumber(event.target.value)} placeholder="e.g. 1" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button type="submit" disabled={loading || openMeetings.length > 0 || !activeCycleId} className="px-4 py-2 font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">{loading ? "Opening..." : "Open Meeting Session"}</button>
        </form>
      ) : (
        <div className="space-y-6">
          <div className="p-3 bg-blue-50 text-blue-800 rounded-lg text-sm space-y-2">
            <div className="flex justify-between items-center gap-3"><span><strong>Active Session:</strong> Meeting #{activeMeeting.meetingNumber} (ID: {activeMeeting.id})</span><span className="text-xs bg-blue-200 px-2 py-1 rounded">Open</span></div>
            {openMeetings.length > 1 && <div><label className="block text-xs font-medium mb-1">More than one meeting was already open</label><select value={String(activeMeeting.id)} onChange={(event) => { const chosen = openMeetings.find((meeting) => String(meeting.id) === event.target.value); if (chosen) setActiveMeeting(chosen); }} className="w-full bg-white border border-blue-200 rounded-lg px-3 py-2 text-slate-800">{openMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>Meeting #{meeting.meetingNumber} (ID: {meeting.id})</option>)}</select><p className="mt-1 text-xs">These sessions were already open before the one-open-meeting rule. Finish and close them one at a time.</p></div>}
          </div>

          <form onSubmit={handleRecordTransactions} className="space-y-4 max-w-2xl">
            <div><label className="block text-sm font-medium text-gray-700">Select Member</label><select required value={selectedMemberId} onChange={(event) => setSelectedMemberId(event.target.value)} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">{members.map((member) => <option key={member.id} value={member.id}>{member.full_name} ({member.phone_number}) - {member.role}</option>)}</select></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium text-gray-700">Shares Purchased (Value: {shareValue.toLocaleString()} RWF / share)</label><input type="number" min="0" step="1" value={sharesCount} onChange={(event) => setSharesCount(event.target.value)} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" /><span className="text-xs text-gray-500">Constitution minimum: {groupRules.minSharesPerMeeting}. Total: {(Number(sharesCount) * shareValue).toLocaleString()} RWF</span></div>
              <div><label className="block text-sm font-medium text-gray-700">Social Fund Contribution (RWF)</label><input type="number" min="0" step="0.01" value={socialFundAmount} onChange={(event) => setSocialFundAmount(event.target.value)} placeholder={groupRules.socialFundMode === "FIXED" ? `${groupRules.socialFundContributionAmount} if present and unpaid` : "Contribution amount"} className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />{groupRules.socialFundMode === "FIXED" && <span className="text-xs text-gray-600">Fixed rule: total must equal exactly {groupRules.socialFundContributionAmount.toLocaleString()} RWF for a present member. If already paid earlier in this meeting, leave this blank; the server checks the total. Attendance: {selectedMemberAttendance.replaceAll("_", " ")}. Record attendance in Meeting Records first. Members marked absent or excused are exempt.</span>}</div>
              <div className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-3">
                <div><label className="block text-sm font-medium text-amber-950">Assess a Fine (optional)</label><select value={fineRuleSelection} onChange={(event) => setFineRuleSelection(event.target.value)} className="w-full px-3 py-2 mt-1 border border-amber-300 rounded-lg bg-white"><option value="">No fine</option>{groupRules.fineRules.map((rule) => <option key={rule.label || rule.name} value={rule.label || rule.name}>{rule.label || rule.name} — {Number(rule.amount).toLocaleString()} RWF</option>)}{groupRules.allowOtherFines && <option value="OTHER">Other — enter reason and amount</option>}</select></div>
                {fineRuleSelection && fineRuleSelection !== "OTHER" && (() => { const rule = groupRules.fineRules.find((item) => String(item.label || item.name) === fineRuleSelection); return <p className="text-sm text-amber-900">The approved amount is <strong>{Number(rule?.amount || 0).toLocaleString()} RWF</strong>. It will be added to this member's outstanding fines. No cash is recorded until the fine is paid.</p>; })()}
                {fineRuleSelection === "OTHER" && <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label className="block text-sm font-medium text-gray-700">Reason for other fine</label><input required minLength="3" maxLength="255" value={otherFineReason} onChange={(event) => setOtherFineReason(event.target.value)} placeholder="Explain the reason" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /></div><div><label className="block text-sm font-medium text-gray-700">Fine amount (RWF)</label><input required type="number" min="0.01" step="0.01" value={otherFineAmount} onChange={(event) => setOtherFineAmount(event.target.value)} placeholder="Amount defined for this case" className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg" /></div><p className="sm:col-span-2 text-xs text-amber-900">Other fines are allowed by the current constitution. This creates an outstanding fine, not a cash receipt.</p></div>}
              </div>
            </div>
            <button type="submit" disabled={loading || members.length === 0} className="px-6 py-2 font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">{loading ? "Recording..." : "Record Member Transactions"}</button>
            <p className="text-xs text-slate-500">After a successful save, the form clears and selects the next member. The meeting remains open so you can continue recording without refreshing the page.</p>
          </form>

          <div className="border-t pt-4 space-y-2">
            <h3 className="font-semibold text-slate-800">Close this meeting</h3>
            <p className="text-sm text-slate-600">Before closing, record attendance for every active member. If the constitution requires a fixed Social Fund contribution, each present member must have paid the exact amount; absent or excused members are exempt. Then visit Cashbook &amp; Reconciliation, keep this meeting selected, and record a physical count for both the Loan Fund and Social Fund. Both counts must match the latest cashbook balances, with no new entries after the counts.</p>
            <div className="flex flex-wrap gap-2">{onOpenCashbook && <button type="button" onClick={onOpenCashbook} className="px-4 py-2 rounded-lg border border-slate-300 text-slate-700 font-semibold hover:bg-slate-50">Open Cashbook &amp; Reconciliation</button>}<button type="button" onClick={handleCloseMeeting} disabled={loading} className="px-4 py-2 rounded-lg font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-50">{loading ? "Please wait..." : `Close Meeting #${activeMeeting.meetingNumber}`}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
