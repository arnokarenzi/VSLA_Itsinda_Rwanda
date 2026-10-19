const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const { loginRateLimit, registrationRateLimit } = require("../middleware/rateLimits");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const { JWT_SECRET } = require("../middleware/auth");

// Register the first ADMIN during group setup, or add members from an authenticated leadership account.
// This prevents a public caller who knows a group ID from manufacturing members or leadership voters.
router.post("/register", registrationRateLimit, async (req, res) => {
  let connection;
  let transactionStarted = false;
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const rawGroupId = body.groupId ?? body.group_id;
    const groupId = Number(rawGroupId);
    const fullName = String(body.fullName ?? body.full_name ?? "").trim();
    const phoneNumber = String(body.phoneNumber ?? body.phone_number ?? "").trim();
    const password = body.password;
    const allowedRoles = ["MEMBER", "TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
    const role = String(req.body.role || "MEMBER").trim().toUpperCase();
    const leadershipRoles = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ success: false, message: "A valid group ID is required." });
    }
    if (!fullName || !phoneNumber || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ success: false, message: "Full name, phone number, and a password of at least 8 characters are required." });
    }
    if (fullName.length > 255 || phoneNumber.length > 50 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Full name is limited to 255 characters, phone number to 50 characters, and password to 128 characters." });
    }
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "The selected group role is invalid." });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [groupRows] = await connection.query("SELECT id, registration_code FROM `groups` WHERE id = ? FOR UPDATE", [groupId]);
    if (!groupRows.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ success: false, message: "The selected group does not exist." });
    }
    const [countRows] = await connection.query("SELECT COUNT(*) AS user_count FROM users WHERE group_id = ?", [groupId]);
    const groupHasUsers = Number(countRows[0]?.user_count || 0) > 0;

    let actor = null;
    if (!groupHasUsers) {
      // Only the first account can be created without a session, and it must be the ADMIN.
      if (role !== "ADMIN") {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "The first account for a new group must be its ADMIN." });
      }
      const suppliedRegistrationCode = String(body.registrationCode || "").trim();
      if (!suppliedRegistrationCode || suppliedRegistrationCode !== String(groupRows[0].registration_code)) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "A valid group registration code is required to create the first ADMIN account." });
      }
    } else {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!token) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(401).json({ success: false, message: "Sign in with a leadership account before adding members." });
      }
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
      } catch {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "Invalid or expired token." });
      }
      if (String(decoded.groupId) !== String(groupId)) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "You can only add users to your own group." });
      }
      const [actorRows] = await connection.query(
        "SELECT id, role, COALESCE(is_active, 1) AS is_active FROM users WHERE id = ? AND group_id = ? FOR UPDATE",
        [decoded.id, groupId],
      );
      actor = actorRows[0];
      if (!actor || Number(actor.is_active) !== 1) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "Your account is inactive or no longer belongs to this group." });
      }
      if (!leadershipRoles.includes(actor.role)) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "Only group leadership can register new members." });
      }
      if (role !== "MEMBER" && !["ADMIN", "CHAIRPERSON"].includes(actor.role)) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(403).json({ success: false, message: "Only the group ADMIN or CHAIRPERSON may assign a leadership role." });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await connection.query(
      `INSERT INTO users (group_id, full_name, phone_number, password_hash, role)
       VALUES (?, ?, ?, ?, ?)`,
      [groupId, fullName, phoneNumber, passwordHash, role],
    );
    await connection.commit();
    transactionStarted = false;
    res.status(201).json({ success: true, message: "User registered successfully", userId: result.insertId });
  } catch (error) {
    if (transactionStarted && connection) await connection.rollback().catch(() => {});
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A member with this phone number already exists." });
    }
    sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  } finally {
    if (connection) connection.release();
  }
});

// Login user and return JWT
router.post("/login", loginRateLimit, async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { phoneNumber, password } = body;
    if (typeof phoneNumber !== "string" || !phoneNumber.trim() || typeof password !== "string" || !password) {
      return res.status(400).json({ success: false, message: "Phone number and password are required." });
    }
    if (phoneNumber.length > 50 || password.length > 128) {
      return res.status(400).json({ success: false, message: "Phone number or password exceeds the allowed length." });
    }

    const [rows] = await db.query(
      "SELECT * FROM users WHERE phone_number = ?",
      [phoneNumber],
    );
    if (rows.length === 0) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid phone number or password." });
    }

    const user = rows[0];
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid phone number or password." });
    }
    if (Number(user.is_active ?? 1) !== 1) {
      return res.status(403).json({ success: false, message: "This account is inactive. Please contact group leadership." });
    }

    // Generate JWT token valid for 24 hours
    const token = jwt.sign(
      {
        id: user.id,
        groupId: user.group_id,
        role: user.role,
        phoneNumber: user.phone_number,
      },
      JWT_SECRET,
      { expiresIn: "24h", algorithm: "HS256" },
    );

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        fullName: user.full_name,
        role: user.role,
        groupId: user.group_id,
      },
    });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  }
});

module.exports = router;
