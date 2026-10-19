import { useState, useEffect, useCallback } from "react";
import API from "../services/api";

export default function MemberManagement({ user }) {
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("password123");
  const [role, setRole] = useState("MEMBER");

  const [membersList, setMembersList] = useState([]);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);
  const groupId = Number(user?.groupId ?? user?.group_id);
  const hasValidGroupId = Number.isSafeInteger(groupId) && groupId > 0;
  const canAssignLeadership = ["ADMIN", "CHAIRPERSON"].includes(String(user?.role || "").toUpperCase());

  const fetchMembers = useCallback(async () => {
    if (!hasValidGroupId) return;
    try {
      const res = await API.get(`/groups/${groupId}/members`);
      if (res.data.success) {
        setMembersList(res.data.members);
      }
    } catch {
      setMessage({ type: "error", text: "Failed to fetch members list." });
    }
  }, [groupId, hasValidGroupId]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      fetchMembers();
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [fetchMembers]);

  const handleAddMember = async (e) => {
    e.preventDefault();
    setMessage({ type: "", text: "" });

    if (!hasValidGroupId) {
      setMessage({
        type: "error",
        text: "Your login is missing a valid group ID. Please sign out and sign in again.",
      });
      return;
    }

    setLoading(true);
    try {
      const payload = {
        groupId,
        fullName: fullName.trim(),
        phoneNumber: phoneNumber.trim(),
        password,
        role,
      };

      const res = await API.post("/auth/register", payload);

      if (res.data.success) {
        setMessage({
          type: "success",
          text: `Member ${fullName} added successfully!`,
        });
        setFullName("");
        setPhoneNumber("");
        setPassword("password123");
        setRole("MEMBER");
        fetchMembers();
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: err.response?.data?.message || "Failed to register new member.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-2xl shadow-2xs border border-slate-200 space-y-6">
      <div className="border-b border-slate-100 pb-3">
        <h2 className="text-lg font-bold text-slate-900">Member Management</h2>
        <p className="text-xs text-slate-500">
          Add and view members in Group #{hasValidGroupId ? groupId : "unavailable"}
        </p>
      </div>

      {message.text && (
        <div
          className={`p-3 text-sm rounded-xl ${
            message.type === "error"
              ? "bg-rose-50 text-rose-700"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Add Member Form */}
      <form onSubmit={handleAddMember} className="space-y-4 max-w-2xl">
        <h3 className="text-sm font-bold text-slate-800">Add New Member</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Full Name
            </label>
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Marie Chantal"
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Phone Number
            </label>
            <input
              type="text"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+2507..."
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Initial Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Group Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              <option value="MEMBER">MEMBER</option>
              {canAssignLeadership && <>
                <option value="TREASURER">TREASURER</option>
                <option value="SECRETARY">SECRETARY</option>
                <option value="CHAIRPERSON">CHAIRPERSON</option>
                <option value="ADMIN">ADMIN</option>
              </>}
            </select>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition disabled:opacity-50"
        >
          {loading ? "Adding..." : "Register Member"}
        </button>
      </form>

      {/* Members Roster Table */}
      <div className="pt-4 border-t border-slate-100">
        <h3 className="text-sm font-bold text-slate-800 mb-3">
          Group Members Directory ({membersList.length})
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-600">
            <thead className="bg-slate-50 text-xs text-slate-400 uppercase">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Phone Number</th>
                <th className="px-3 py-2">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {membersList.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2.5 font-semibold text-slate-900">
                    {m.full_name}
                  </td>
                  <td className="px-3 py-2.5">{m.phone_number}</td>
                  <td className="px-3 py-2.5">
                    <span className="px-2.5 py-0.5 text-xs font-semibold text-emerald-700 bg-emerald-50 rounded-full border border-emerald-100">
                      {m.role}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
