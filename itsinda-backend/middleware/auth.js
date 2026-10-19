"use strict";

require("dotenv").config();
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { DEFAULT_DEVELOPMENT_JWT_SECRET, extractBearerToken } = require("../security/securityControls");

// The development fallback keeps local setup easy. server.js refuses to start in
// production unless a unique, sufficiently long JWT_SECRET is configured.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : DEFAULT_DEVELOPMENT_JWT_SECRET);

/** Verify the token and re-check current account status and role in the database. */
async function verifyToken(req, res, next) {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: req.headers.authorization ? "Access denied. Use a valid Bearer token." : "Access denied. No token provided.",
    });
  }
  if (!JWT_SECRET) {
    return res.status(503).json({ success: false, message: "Authentication is not configured on this server." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ success: false, message: "Your session is invalid or has expired. Please sign in again." });
  }

  const tokenUserId = Number(decoded?.id);
  if (!Number.isSafeInteger(tokenUserId) || tokenUserId <= 0) {
    return res.status(401).json({ success: false, message: "Your session is invalid. Please sign in again." });
  }

  try {
    const [rows] = await db.query(
      `SELECT id, group_id, role, phone_number, COALESCE(is_active, 1) AS is_active
       FROM users WHERE id = ? LIMIT 1`,
      [tokenUserId],
    );
    const account = rows[0];
    if (!account || Number(account.is_active) !== 1) {
      return res.status(401).json({ success: false, message: "This account is inactive or no longer available. Please contact group leadership." });
    }

    // Use current database values instead of stale role/group claims from the JWT.
    req.user = {
      id: Number(account.id),
      groupId: Number(account.group_id),
      role: account.role,
      phoneNumber: account.phone_number,
      iat: decoded.iat,
      exp: decoded.exp,
    };
    return next();
  } catch (error) {
    console.error("[auth-account-check-failed]", String(error.code || "UNKNOWN"));
    return res.status(503).json({ success: false, message: "Could not verify your account right now. Please try again." });
  }
}

function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access forbidden. Required role(s): ${allowedRoles.join(", ")}`,
      });
    }
    return next();
  };
}

function verifyGroupOwnership(req, res, next) {
  const requestedGroupId = req.params.groupId || req.params.id;
  if (!req.user || !req.user.groupId || !requestedGroupId) {
    return res.status(403).json({ success: false, message: "Access forbidden. Missing user or group association." });
  }
  if (String(req.user.groupId) !== String(requestedGroupId)) {
    return res.status(403).json({ success: false, message: "Access forbidden. You do not have permission to access data for this association." });
  }
  return next();
}

module.exports = { verifyToken, requireRole, verifyGroupOwnership, JWT_SECRET, extractBearerToken };
