import { useEffect, useState } from "react";
import Login from "./components/Login";
import RegisterGroup from "./components/RegisterGroup";
import Dashboard from "./components/Dashboard";

export default function App() {
  const [user, setUser] = useState(() => {
    try {
      const savedUser = localStorage.getItem("itsinda_user");
      return savedUser ? JSON.parse(savedUser) : null;
    } catch {
      localStorage.removeItem("itsinda_user");
      localStorage.removeItem("itsinda_token");
      return null;
    }
  });

  const [view, setView] = useState("login"); // 'login' or 'register'
  const [recordFeedback, setRecordFeedback] = useState(null);

  useEffect(() => {
    const handleRecordFeedback = (event) => setRecordFeedback(event.detail || null);
    window.addEventListener("itsinda:record-feedback", handleRecordFeedback);
    return () => window.removeEventListener("itsinda:record-feedback", handleRecordFeedback);
  }, []);

  useEffect(() => {
    const handleExpiredSession = () => {
      setUser(null);
      setView("login");
    };
    window.addEventListener("itsinda:session-expired", handleExpiredSession);
    return () => window.removeEventListener("itsinda:session-expired", handleExpiredSession);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("itsinda_token");
    localStorage.removeItem("itsinda_user");
    setUser(null);
    setView("login");
  };

  let page;
  if (!user) {
    if (view === "register") {
      page = <RegisterGroup
        onRegistrationSuccess={() => setView("login")}
        onBackToLogin={() => setView("login")}
      />;
    } else {
      page = <Login
        onLoginSuccess={(loggedInUser) => setUser(loggedInUser)}
        onGoToRegister={() => setView("register")}
      />;
    }
  } else {
    page = <Dashboard user={user} onLogout={handleLogout} />;
  }

  return (
    <>
      {page}
      {recordFeedback && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/45 p-4" role="presentation">
          <div role="alertdialog" aria-modal="true" aria-labelledby="record-feedback-title" aria-describedby="record-feedback-message"
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <div className={`mx-auto flex h-14 w-14 items-center justify-center rounded-full text-3xl font-black ${recordFeedback.type === "success" ? "bg-emerald-100 text-emerald-700" : recordFeedback.type === "warning" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-700"}`} aria-hidden="true">
              {recordFeedback.type === "success" ? "✓" : recordFeedback.type === "warning" ? "!" : "✕"}
            </div>
            <h2 id="record-feedback-title" className={`mt-4 text-center text-xl font-bold ${recordFeedback.type === "success" ? "text-emerald-800" : recordFeedback.type === "warning" ? "text-amber-800" : "text-rose-800"}`}>
              {recordFeedback.type === "success" ? "Record saved" : recordFeedback.type === "warning" ? "Save status unknown" : "Record not saved"}
            </h2>
            <p id="record-feedback-message" className="mt-2 whitespace-pre-wrap break-words text-center text-sm text-slate-700">{recordFeedback.message}</p>
            <button autoFocus type="button" onClick={() => setRecordFeedback(null)} className={`mt-6 w-full rounded-lg px-4 py-2.5 font-semibold text-white ${recordFeedback.type === "success" ? "bg-emerald-700 hover:bg-emerald-800" : recordFeedback.type === "warning" ? "bg-amber-700 hover:bg-amber-800" : "bg-rose-700 hover:bg-rose-800"}`}>
              OK
            </button>
          </div>
        </div>
      )}
    </>
  );
}
