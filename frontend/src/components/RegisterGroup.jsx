import { useState } from "react";
import API from "../services/api";

export default function RegisterGroup({
  onRegistrationSuccess,
  onBackToLogin,
}) {
  const [groupName, setGroupName] = useState("");
  const [district, setDistrict] = useState("");
  const [sector, setSector] = useState("");
  const [shareValue, setShareValue] = useState(1000);

  // Admin User details
  const [fullName, setFullName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");

  const [message, setMessage] = useState({ type: "", text: "" });
  const [loading, setLoading] = useState(false);

  const handleRegisterGroup = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage({ type: "", text: "" });

    try {
      // 1. Create Group
      const groupRes = await API.post("/groups", {
        name: groupName,
        district,
        sector,
        settings: { shareValue: Number(shareValue) },
      });

      if (groupRes.data.success) {
        const createdGroupId = groupRes.data.group.id;

        // 2. Register Admin User for the Group
        const userRes = await API.post("/auth/register", {
          groupId: createdGroupId,
          registrationCode: groupRes.data.group.registration_code,
          fullName,
          phoneNumber,
          password,
          role: "ADMIN",
        });

        if (userRes.data.success) {
          setMessage({
            type: "success",
            text: "Group and Admin account registered successfully! You can now sign in.",
          });
          if (onRegistrationSuccess) {
            setTimeout(() => onRegistrationSuccess(), 2000);
          }
        }
      }
    } catch (err) {
      setMessage({
        type: "error",
        text:
          err.response?.data?.message ||
          "Failed to register group and admin user.",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900 px-4 py-8">
      <div className="w-full max-w-xl p-8 space-y-6 bg-white rounded-2xl shadow-2xl border border-slate-100">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-emerald-50 text-emerald-600 rounded-xl font-bold text-lg mb-1 shadow-inner">
            IS
          </div>
          <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">
            Register New Group
          </h2>
          <p className="text-xs text-slate-500">
            Setup your VSLA group subscription and admin account
          </p>
        </div>

        {message.text && (
          <div
            className={`p-4 text-sm rounded-xl font-medium ${
              message.type === "error"
                ? "bg-rose-50 text-rose-700 border border-rose-100"
                : "bg-emerald-50 text-emerald-700 border border-emerald-100"
            }`}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleRegisterGroup} className="space-y-6">
          {/* Group Details */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 pb-2">
              1. Group Details
            </h3>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                Group Name
              </label>
              <input
                type="text"
                required
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="e.g. Abahujimugambi VSLA"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white text-sm"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  District
                </label>
                <input
                  type="text"
                  required
                  value={district}
                  onChange={(e) => setDistrict(e.target.value)}
                  placeholder="e.g. Gasabo"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Sector
                </label>
                <input
                  type="text"
                  required
                  value={sector}
                  onChange={(e) => setSector(e.target.value)}
                  placeholder="e.g. Remera"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Share Price (RWF)
                </label>
                <input
                  type="number"
                  required
                  min="100"
                  value={shareValue}
                  onChange={(e) => setShareValue(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
                />
              </div>
            </div>
          </div>

          {/* Admin Details */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 border-b border-slate-100 pb-2">
              2. Group Admin Account
            </h3>
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                Full Name
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Jean Paul"
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Phone Number
                </label>
                <input
                  type="text"
                  required
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="+25078..."
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-lg shadow-emerald-600/20 text-sm transition"
            >
              {loading ? "Creating Group..." : "Register Group & Continue"}
            </button>
            <button
              type="button"
              onClick={onBackToLogin}
              className="w-full py-2.5 text-xs font-bold text-slate-500 hover:text-slate-800 transition"
            >
              Back to Sign In
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
