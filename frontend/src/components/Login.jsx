import { useState } from "react";
import API from "../services/api";

export default function Login({ onLoginSuccess, onGoToRegister }) {
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await API.post("/auth/login", {
        phoneNumber,
        password,
      });

      if (response.data.success) {
        const { token, user } = response.data;
        localStorage.setItem("itsinda_token", token);
        localStorage.setItem("itsinda_user", JSON.stringify(user));

        if (onLoginSuccess) onLoginSuccess(user);
      }
    } catch (err) {
      setError(
        err.response?.data?.message ||
          "Login failed. Please check your credentials.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-slate-900 px-4">
      <div className="w-full max-w-md p-8 space-y-8 bg-white rounded-2xl shadow-2xl border border-slate-100">
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 bg-emerald-50 text-emerald-600 rounded-2xl font-bold text-xl mb-2 shadow-inner">
            IS
          </div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">
            Itsinda System
          </h2>
          <p className="text-sm text-slate-500">
            Secure Village Savings and Loan Association Platform
          </p>
        </div>

        {error && (
          <div className="p-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-xl font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
              Phone Number
            </label>
            <input
              type="text"
              required
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="+250788..."
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
            />
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 mb-1.5">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:bg-white transition"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3.5 font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-lg shadow-emerald-600/20 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 transition duration-200"
          >
            {loading ? "Authenticating..." : "Sign In"}
          </button>
          <button
            type="button"
            onClick={onGoToRegister}
            className="w-full py-2.5 text-xs font-bold text-emerald-600 hover:text-emerald-700 transition"
          >
            Want to register a new VSLA Group? Click here
          </button>
        </form>
      </div>
    </div>
  );
}
