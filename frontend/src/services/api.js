import axios from "axios";

// Set VITE_API_BASE_URL in each deployment (for example, https://api.example.com/api).
// The localhost fallback is for local development only.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api";

const API = axios.create({
  baseURL: API_BASE_URL.replace(/\/$/, ""),
  timeout: 20000,
  headers: { Accept: "application/json" },
});

// Attach the bearer token without logging it or placing it in a URL.
API.interceptors.request.use((config) => {
  const token = localStorage.getItem("itsinda_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Expired/disabled sessions are cleared consistently instead of leaving the UI
// in a logged-in state that can no longer call the API. Don't react to login errors.
API.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url = String(error?.config?.url || "");
    const isAuthEndpoint = url.includes("/auth/login") || url.includes("/auth/register");
    if (status === 401 && !isAuthEndpoint) {
      localStorage.removeItem("itsinda_token");
      localStorage.removeItem("itsinda_user");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("itsinda:session-expired"));
      }
    }
    return Promise.reject(error);
  },
);

export default API;
