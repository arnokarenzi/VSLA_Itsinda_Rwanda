import { useCallback, useEffect, useState } from "react";
import API from "../services/api";

export default function LoanOperations({
  user,
  activeCycleId = null,
  onLoanProcessed,
  onOpenCashbook,
  refreshKey = 0,
}) {
  const groupId = Number(user?.groupId ?? user?.group_id);
  const [members, setMembers] = useState([]);
  const [allMembers, setAllMembers] = useState([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [repaymentMemberId, setRepaymentMemberId] = useState("");
  const [memberLoans, setMemberLoans] = useState([]);
  const [loadingMemberLoans, setLoadingMemberLoans] = useState(false);
  const [repaymentLoansRefresh, setRepaymentLoansRefresh] = useState(0);
  const [openMeetings, setOpenMeetings] = useState([]);
  const [selectedMeetingId, setSelectedMeetingId] = useState("");

  const [principalAmount, setPrincipalAmount] = useState("");
  const [durationMonths, setDurationMonths] = useState(3);
  const [dueDate, setDueDate] = useState("");
  const [selectedLoanId, setSelectedLoanId] = useState("");
  const [repaymentAmount, setRepaymentAmount] = useState("");
  const [message, setMessage] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [loadingMeetings, setLoadingMeetings] = useState(false);
  const [constitutionTerms, setConstitutionTerms] = useState({
    loanRatioLimit: 3,
    monthlyInterestRate: 0.05,
    interestMethod: "FLAT_PER_MONTH",
    maxLoanDurationMonths: 12,
  });

  const fetchOpenMeetings = useCallback(async () => {
    if (!Number.isSafeInteger(groupId) || groupId <= 0 || !activeCycleId) {
      setOpenMeetings([]);
      setSelectedMeetingId("");
      return;
    }

    setLoadingMeetings(true);
    try {
      const response = await API.get(`/groups/${groupId}/meetings/open`, {
        params: { cycleId: activeCycleId },
      });
      const meetings = response.data.success ? response.data.meetings || [] : [];
      setOpenMeetings(meetings);
      setSelectedMeetingId((current) =>
        meetings.some((meeting) => String(meeting.id) === String(current))
          ? String(current)
          : meetings.length
            ? String(meetings[0].id)
            : "",
      );
    } catch (err) {
      setOpenMeetings([]);
      setSelectedMeetingId("");
      setMessage({
        type: "error",
        text:
          err.response?.data?.message ||
          "Could not load open meeting sessions.",
      });
    } finally {
      setLoadingMeetings(false);
    }
  }, [groupId, activeCycleId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchOpenMeetings();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [fetchOpenMeetings, refreshKey]);

  useEffect(() => {
    let isMounted = true;
    const fetchMembers = async () => {
      try {
        const membersRes = await API.get(`/groups/${groupId}/members`);
        if (isMounted && membersRes.data.success) {
          const allGroupMembers = membersRes.data.members || [];
          const activeMembers = allGroupMembers.filter(
            (member) => Number(member.is_active) !== 0,
          );
          setAllMembers(allGroupMembers);
          setMembers(activeMembers);
          setSelectedMemberId((current) =>
            activeMembers.some(
              (member) => String(member.id) === String(current),
            )
              ? current
              : activeMembers.length
                ? String(activeMembers[0].id)
                : "",
          );
          setRepaymentMemberId((current) =>
            allGroupMembers.some((member) => String(member.id) === String(current))
              ? current
              : "",
          );
        }
      } catch (err) {
        if (isMounted)
          setMessage({
            type: "error",
            text:
              err.response?.data?.message || "Failed to load loan form data.",
          });
      }
    };
    void fetchMembers();
    return () => {
      isMounted = false;
    };
  }, [groupId]);

  useEffect(() => {
    let isCurrentRequest = true;
    const resetTimeoutId = window.setTimeout(() => {
      if (isCurrentRequest) {
        setMemberLoans([]);
        setSelectedLoanId("");
      }
    }, 0);

    if (
      !Number.isSafeInteger(groupId) || groupId <= 0 ||
      !Number.isSafeInteger(Number(activeCycleId)) || Number(activeCycleId) <= 0 ||
      !Number.isSafeInteger(Number(repaymentMemberId)) || Number(repaymentMemberId) <= 0
    ) {
      return () => {
        isCurrentRequest = false;
        window.clearTimeout(resetTimeoutId);
      };
    }

    const fetchOutstandingLoans = async () => {
      setLoadingMemberLoans(true);
      try {
        const response = await API.get(`/groups/${groupId}/loans/outstanding`, {
          params: { cycleId: Number(activeCycleId), memberId: Number(repaymentMemberId) },
        });
        if (isCurrentRequest) {
          setMemberLoans(response.data?.success ? response.data.loans || [] : []);
        }
      } catch (err) {
        if (isCurrentRequest) {
          setMemberLoans([]);
          setMessage({
            type: "error",
            text: err.response?.data?.message || "Could not load this borrower's outstanding loans.",
          });
        }
      } finally {
        if (isCurrentRequest) setLoadingMemberLoans(false);
      }
    };

    void fetchOutstandingLoans();
    return () => {
      isCurrentRequest = false;
      window.clearTimeout(resetTimeoutId);
    };
  }, [groupId, activeCycleId, repaymentMemberId, repaymentLoansRefresh]);

  useEffect(() => {
    let isMounted = true;
    const fetchConstitutionTerms = async () => {
      try {
        const response = await API.get(`/groups/${groupId}/constitution`);
        const terms = response.data?.constitution?.current?.terms;
        if (isMounted && terms) {
          const nextTerms = {
            loanRatioLimit: Number(terms.loanRatioLimit ?? 3),
            monthlyInterestRate: Number(terms.monthlyInterestRate ?? 0.05),
            interestMethod: terms.interestMethod || "FLAT_PER_MONTH",
            maxLoanDurationMonths: Number(terms.maxLoanDurationMonths ?? 12),
          };
          setConstitutionTerms(nextTerms);
          setDurationMonths((current) =>
            Math.min(Number(current) || 1, nextTerms.maxLoanDurationMonths),
          );
        }
      } catch {
        // The backend remains authoritative. Keep backward-compatible UI defaults if the rules cannot load.
      }
    };
    if (Number.isSafeInteger(groupId) && groupId > 0)
      void fetchConstitutionTerms();
    return () => {
      isMounted = false;
    };
  }, [groupId]);

  const selectedRepaymentLoan = memberLoans.find((loan) => String(loan.loanId) === String(selectedLoanId));

  const handleIssueLoan = async (e) => {
    e.preventDefault();
    setMessage({ type: "", text: "" });
    if (!selectedMeetingId) {
      setMessage({
        type: "error",
        text: "Open a meeting session in Meeting Operations before issuing a loan.",
      });
      return;
    }
    if (
      !selectedMemberId ||
      !Number.isFinite(Number(principalAmount)) ||
      Number(principalAmount) <= 0
    ) {
      setMessage({
        type: "error",
        text: "Select a borrower and enter a valid principal amount.",
      });
      return;
    }
    setLoading(true);
    try {
      const res = await API.post(`/groups/${groupId}/loans`, {
        cycleId: Number(activeCycleId),
        meetingId: Number(selectedMeetingId),
        memberId: Number(selectedMemberId),
        principalAmount: Number(principalAmount),
        durationMonths: Number(durationMonths),
        dueDate:
          dueDate ||
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
      });
      if (res.data.success) {
        const loan = res.data.loan;
        setMessage({
          type: "success",
          text: `Loan #${loan.loanId} issued. ${Number(loan.principalAmount).toLocaleString()} RWF left the loan fund; expected interest is ${Number(loan.totalInterestDue).toLocaleString()} RWF. ${loan.receipt?.receiptNumber ? `Receipt: ${loan.receipt.receiptNumber}. Open Meeting Records & Receipts to print it.` : ""}`,
        });
        setPrincipalAmount("");
        if (onLoanProcessed) onLoanProcessed();
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err.response?.data?.message || "Failed to issue loan.",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleRepayLoan = async (e) => {
    e.preventDefault();
    setMessage({ type: "", text: "" });
    if (!selectedMeetingId) {
      setMessage({
        type: "error",
        text: "Open a meeting session in Meeting Operations before recording a repayment.",
      });
      return;
    }
    if (!repaymentMemberId || !Number.isSafeInteger(Number(repaymentMemberId)) || Number(repaymentMemberId) <= 0) {
      setMessage({ type: "error", text: "Select the borrower first." });
      return;
    }
    if (
      !selectedLoanId ||
      !Number.isSafeInteger(Number(selectedLoanId)) ||
      Number(selectedLoanId) <= 0 ||
      !selectedRepaymentLoan
    ) {
      setMessage({ type: "error", text: "Select one of this borrower's outstanding loans." });
      return;
    }
    if (
      !Number.isFinite(Number(repaymentAmount)) ||
      Number(repaymentAmount) <= 0
    ) {
      setMessage({ type: "error", text: "Enter a valid repayment amount." });
      return;
    }
    setLoading(true);
    try {
      const res = await API.post(`/loans/${Number(selectedLoanId)}/repay`, {
        groupId,
        cycleId: Number(activeCycleId),
        meetingId: Number(selectedMeetingId),
        memberId: Number(repaymentMemberId),
        repaymentAmount: Number(repaymentAmount),
      });
      if (res.data.success) {
        const repayment = res.data.repayment;
        setMessage({
          type: "success",
          text: `Repayment recorded: ${Number(repayment.principalPaid).toLocaleString()} RWF principal and ${Number(repayment.interestPaid).toLocaleString()} RWF interest. Remaining balance: ${Number(repayment.balanceRemaining).toLocaleString()} RWF. ${repayment.receipt?.receiptNumber ? `Receipt: ${repayment.receipt.receiptNumber}. Open Meeting Records & Receipts to print it.` : ""}`,
        });
        setRepaymentAmount("");
        setSelectedLoanId("");
        setRepaymentLoansRefresh((current) => current + 1);
        if (onLoanProcessed) onLoanProcessed();
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err.response?.data?.message || "Failed to process repayment.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 space-y-6">
      <h2 className="text-xl font-bold text-gray-800 border-b pb-3">
        Loan Management (Issue &amp; Repay)
      </h2>

      {message.text && (
        <div
          className={`p-3 rounded-lg text-sm ${message.type === "error" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}
        >
          {message.text}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm text-slate-800">
        <h3 className="font-semibold">Current group loan rules</h3>
        <p>
          Maximum loan: {constitutionTerms.loanRatioLimit}× member savings.
          Interest/service charge:{" "}
          {(constitutionTerms.monthlyInterestRate * 100).toLocaleString()}%{" "}
          {constitutionTerms.interestMethod === "FLAT_ONCE"
            ? "once per loan"
            : "per month (flat)"}
          . Maximum term: {constitutionTerms.maxLoanDurationMonths} month(s).
          The server enforces the current rules when the loan is submitted.
        </p>
        <p className="text-xs text-slate-500">
          For all approved group rules, open{" "}
          <strong>Constitution &amp; Rules</strong> from the sidebar.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2 text-sm text-amber-900">
        <h3 className="font-semibold">
          Before issuing a loan: verify physical cash
        </h3>
        <p>
          Before a loan can be disbursed, the Loan Fund must have a physical
          cash count on file with no unresolved difference. Count the cash
          actually held by the group, then save it under Cashbook &amp;
          Reconciliation. Do not enter the expected balance unless that is the
          amount physically counted.
        </p>
        {onOpenCashbook && (
          <button
            type="button"
            onClick={onOpenCashbook}
            className="rounded-lg border border-amber-300 bg-white px-3 py-2 font-semibold hover:bg-amber-100"
          >
            Open Cashbook &amp; Reconciliation
          </button>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
        <label className="block text-sm font-medium text-slate-700">
          Open meeting for this cash movement
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            value={selectedMeetingId}
            onChange={(e) => setSelectedMeetingId(e.target.value)}
            disabled={loadingMeetings || openMeetings.length === 0}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-white"
          >
            <option value="">
              {loadingMeetings
                ? "Loading open meetings..."
                : "Select an open meeting"}
            </option>
            {openMeetings.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                Meeting #{meeting.meeting_number} (ID: {meeting.id}) —{" "}
                {String(meeting.date).slice(0, 10)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={fetchOpenMeetings}
            disabled={loadingMeetings}
            className="px-3 py-2 border rounded-lg text-sm font-semibold hover:bg-white disabled:opacity-50"
          >
            Refresh meetings
          </button>
        </div>
        {!loadingMeetings && openMeetings.length === 0 && (
          <p className="text-xs text-amber-700">
            No open meeting was found. Open a meeting in Meeting Operations,
            then refresh this list.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <form onSubmit={handleIssueLoan} className="space-y-4">
          <h3 className="text-md font-semibold text-gray-700">
            Issue New Loan
          </h3>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Borrower Member
            </label>
            <select
              required
              value={selectedMemberId}
              onChange={(e) => setSelectedMemberId(e.target.value)}
              className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg"
            >
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name} ({member.phone_number})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Principal Amount (RWF)
            </label>
            <input
              type="number"
              required
              min="1"
              step="0.01"
              value={principalAmount}
              onChange={(e) => setPrincipalAmount(e.target.value)}
              placeholder="e.g. 10000"
              className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Duration (Months)
              </label>
              <input
                type="number"
                required
                min="1"
                max={constitutionTerms.maxLoanDurationMonths}
                value={durationMonths}
                onChange={(e) => setDurationMonths(e.target.value)}
                className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Due Date
              </label>
              <input
                type="date"
                required
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={
              loading ||
              loadingMeetings ||
              !selectedMeetingId ||
              !members.length
            }
            className="w-full py-2 font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? "Processing..." : "Issue Loan"}
          </button>
        </form>

        <form onSubmit={handleRepayLoan} className="space-y-4">
          <h3 className="text-md font-semibold text-gray-700">
            Record Loan Repayment
          </h3>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Borrower Member
            </label>
            <select
              required
              value={repaymentMemberId}
              onChange={(e) => {
                setRepaymentMemberId(e.target.value);
                setSelectedLoanId("");
                setRepaymentAmount("");
                setMessage({ type: "", text: "" });
              }}
              className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg bg-white"
            >
              <option value="">Select the borrower</option>
              {allMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.full_name} ({member.phone_number}){Number(member.is_active) === 0 ? " — inactive member" : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Outstanding Loan
            </label>
            <select
              required
              value={selectedLoanId}
              onChange={(e) => {
                setSelectedLoanId(e.target.value);
                setRepaymentAmount("");
              }}
              disabled={!repaymentMemberId || loadingMemberLoans || memberLoans.length === 0}
              className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg bg-white disabled:bg-gray-100"
            >
              <option value="">
                {loadingMemberLoans
                  ? "Loading this borrower's loans..."
                  : !repaymentMemberId
                    ? "Select a borrower first"
                    : memberLoans.length === 0
                      ? "No outstanding loans in the active cycle"
                      : "Select the loan to repay"}
              </option>
              {memberLoans.map((loan) => (
                <option key={loan.loanId} value={loan.loanId}>
                  {`Loan #${loan.loanId} — Principal ${Number(loan.principalAmount).toLocaleString()} RWF — Remaining ${Number(loan.balanceRemaining).toLocaleString()} RWF — Due ${String(loan.dueDate).slice(0, 10)}`}
                </option>
              ))}
            </select>
          </div>
          {selectedRepaymentLoan && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 space-y-1">
              <p className="font-semibold">Selected Loan #{selectedRepaymentLoan.loanId}</p>
              <p>Original principal: {Number(selectedRepaymentLoan.principalAmount).toLocaleString()} RWF</p>
              <p>Total interest/service charge due at issuance: {Number(selectedRepaymentLoan.totalInterestDue).toLocaleString()} RWF</p>
              <p className="font-semibold">Current outstanding balance: {Number(selectedRepaymentLoan.balanceRemaining).toLocaleString()} RWF</p>
              <p>Due date: {String(selectedRepaymentLoan.dueDate).slice(0, 10)}</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Repayment Amount (RWF)
            </label>
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              value={repaymentAmount}
              onChange={(e) => setRepaymentAmount(e.target.value)}
              placeholder="e.g. 5000"
              className="w-full px-3 py-2 mt-1 border border-gray-300 rounded-lg"
            />
          </div>
          <p className="text-xs text-gray-500">
            The list shows this borrower's unpaid loans in the active cycle. Select the exact loan before entering the payment. Repayments are applied to outstanding interest first, then principal; payments above the selected loan's remaining balance are rejected.
          </p>
          <button
            type="submit"
            disabled={loading || loadingMeetings || loadingMemberLoans || !selectedMeetingId || !repaymentMemberId || !selectedLoanId || !selectedRepaymentLoan}
            className="w-full py-2 font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? "Processing..." : "Submit Repayment"}
          </button>
        </form>
      </div>
    </div>
  );
}
