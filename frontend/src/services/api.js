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

// All write requests receive a global, dismissible tick/cross message. The server
// sends success only after its database transaction commits, so a green message is
// a confirmation of persistence rather than merely of button submission.
function isWriteRequest(config) {
  return ["post", "put", "patch", "delete"].includes(String(config?.method || "get").toLowerCase());
}
function isLoginRequest(config) {
  return String(config?.url || "").includes("/auth/login");
}
function dispatchRecordFeedback(type, message) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("itsinda:record-feedback", {
    detail: { type, message: String(message || (type === "success" ? "Record saved successfully." : "The record could not be saved.")) },
  }));
}

// Expired/disabled sessions are cleared consistently instead of leaving the UI
// in a logged-in state that can no longer call the API. Login failures stay on the login form.
API.interceptors.response.use(
  (response) => {
    const { config, data } = response;
    if (isWriteRequest(config) && !isLoginRequest(config) && !config?.suppressRecordFeedback) {
      if (data?.success === false) dispatchRecordFeedback("error", data.message || "The server did not save this record.");
      else dispatchRecordFeedback("success", data?.message || "Record saved successfully in the database.");
    }
    return response;
  },
  (error) => {
    const status = error?.response?.status;
    const url = String(error?.config?.url || "");
    const isLoginEndpoint = url.includes("/auth/login");
    if (isWriteRequest(error?.config) && !isLoginEndpoint && !error?.config?.suppressRecordFeedback && error?.code !== "ERR_CANCELED") {
      dispatchRecordFeedback(error?.response ? "error" : "warning", error?.response?.data?.message || (error?.response
        ? `The record was not saved (HTTP ${status || "error"}).`
        : "The server could not be reached. The save status is unknown; check the current records before retrying to avoid a duplicate."));
    }
    if (status === 401 && !isLoginEndpoint) {
      localStorage.removeItem("itsinda_token");
      localStorage.removeItem("itsinda_user");
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("itsinda:session-expired"));
    }
    return Promise.reject(error);
  },
);

export default API;
