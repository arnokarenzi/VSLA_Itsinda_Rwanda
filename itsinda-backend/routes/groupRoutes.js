const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const db = require("../config/db");
const crypto = require("node:crypto");
const { groupCreationRateLimit } = require("../middleware/rateLimits");
const { verifyToken, verifyGroupOwnership } = require("../middleware/auth");
const { normalizeConstitution } = require("../services/constitutionRules");

// Register a new VSLA group (Public route for onboarding)
router.post("/", groupCreationRateLimit, async (req, res) => {
  let connection;
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { name, district, sector } = body;
    let settings = body.settings;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Group name is required." });
    }
    if (String(name).trim().length > 255) {
      return res.status(400).json({ success: false, message: "Group name cannot exceed 255 characters." });
    }

    // The frontend previously sent settings as a JSON string. Accept either
    // representation so custom shareValue values are not silently discarded.
    if (typeof settings === "string") {
      try {
        settings = JSON.parse(settings);
      } catch {
        return res.status(400).json({
          success: false,
          message: "Group settings must be valid JSON.",
        });
      }
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      settings = {};
    }

    const parsedShareValue = Number(settings.shareValue ?? 1000);
    if (!Number.isFinite(parsedShareValue) || parsedShareValue <= 0) {
      return res.status(400).json({
        success: false,
        message: "Share value must be a positive number.",
      });
    }

    const registrationCode = "IS-" + crypto.randomBytes(5).toString("hex").toUpperCase();
    // Validate and store complete interim rules for new groups. Group leadership
    // can submit a versioned proposal for member ratification from Constitution & Rules.
    let validatedTerms;
    try {
      validatedTerms = normalizeConstitution({ ...settings, shareValue: parsedShareValue });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }
    const groupSettings = {
      ...settings,
      ...validatedTerms,
      district: district || settings.district || "",
      sector: sector || settings.sector || "",
    };

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [result] = await connection.query(
      "INSERT INTO `groups` (name, registration_code, settings) VALUES (?, ?, ?)",
      [String(name).trim(), registrationCode, JSON.stringify(groupSettings)],
    );

    // Every new group starts with its own active cycle. Cycle IDs are global,
    // not the same as cycle_number, so the UI must not hard-code cycle ID 1.
    await connection.query(
      "INSERT INTO cycles (group_id, cycle_number, start_date, status) VALUES (?, 1, CURDATE(), 'ACTIVE')",
      [result.insertId],
    );

    const [newGroupRows] = await connection.query(
      "SELECT * FROM `groups` WHERE id = ?",
      [result.insertId],
    );

    await connection.commit();
    connection.release();
    connection = null;

    res.status(201).json({
      success: true,
      message: "Group created successfully",
      group: newGroupRows[0],
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch {
        // Preserve the original error.
      }
      connection.release();
    }
    sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  }
});

// Get the active cycle belonging to a specific group.
router.get(
  "/:groupId/cycles/active",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const [rows] = await db.query(
        `SELECT id, group_id, cycle_number, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
               DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date, status
         FROM cycles
         WHERE group_id = ? AND status IN ('ACTIVE', 'CLOSING')
         ORDER BY CASE WHEN status = 'CLOSING' THEN 0 ELSE 1 END, cycle_number DESC, id DESC
         LIMIT 1`,
        [groupId],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "No active cycle exists for this group. A leadership member must complete the prior cycle or ask an administrator to create the initial cycle.",
        });
      }

      res.status(200).json({ success: true, cycle: rows[0] });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);

// Get group details (Requires token and group ownership)
router.get("/:groupId", verifyToken, verifyGroupOwnership, async (req, res) => {
  try {
    const { groupId } = req.params;
    const [rows] = await db.query(
      "SELECT id, name, created_at, settings FROM `groups` WHERE id = ?",
      [groupId],
    );

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Group not found" });
    }

    res.status(200).json({ success: true, group: rows[0] });
  } catch (error) {
    sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
  }
});

// Get members of a specific group
router.get(
  "/:groupId/members",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const [rows] = await db.query(
        "SELECT id, full_name, phone_number, role, is_active, created_at FROM users WHERE group_id = ?",
        [groupId],
      );

      res.status(200).json({ success: true, members: rows });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);

module.exports = router;
