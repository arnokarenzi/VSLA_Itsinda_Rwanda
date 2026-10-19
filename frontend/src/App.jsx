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

  if (!user) {
    if (view === "register") {
      return (
        <RegisterGroup
          onRegistrationSuccess={() => setView("login")}
          onBackToLogin={() => setView("login")}
        />
      );
    }
    return (
      <Login
        onLoginSuccess={(loggedInUser) => setUser(loggedInUser)}
        onGoToRegister={() => setView("register")}
      />
    );
  }

  return <Dashboard user={user} onLogout={handleLogout} />;
}
