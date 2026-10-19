const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { openMeeting, closeMeeting, recordMeetingTransactions } = require("../services/meetingService");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const db = require("../config/db");
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];

// List open meetings for a group's selected cycle; used by loan and cashbook forms.
router.get(
  "/groups/:groupId/meetings/open",
  verifyToken,
  verifyGroupOwnership,
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const cycleId = Number(req.query.cycleId);
      if (!Number.isSafeInteger(groupId) || groupId <= 0 || !Number.isSafeInteger(cycleId) || cycleId <= 0) {
        return res.status(400).json({ success: false, message: "A valid group ID and cycle ID are required." });
      }
      const [rows] = await db.query(
        `SELECT id, group_id, cycle_id, meeting_number, date, status
         FROM meetings WHERE group_id = ? AND cycle_id = ? AND status = 'OPEN'
         ORDER BY meeting_number DESC, id DESC`,
        [groupId, cycleId],
      );
      const [nextRows] = await db.query(
        `SELECT COALESCE(MAX(meeting_number), 0) + 1 AS next_meeting_number
         FROM meetings WHERE group_id = ? AND cycle_id = ?`,
        [groupId, cycleId],
      );
      res.status(200).json({ success: true, meetings: rows,
        nextMeetingNumber: Number(nextRows[0]?.next_meeting_number || 1) });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 500, fallbackMessage: "The server could not complete this request." });
    }
  },
);

router.post(
  "/groups/:groupId/meetings",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { cycleId, meetingNumber, date } = req.body;
      const meeting = await openMeeting(groupId, cycleId, meetingNumber, date, req.user.id, auditMetaFor(req));
      res.status(201).json({ success: true, message: "Meeting opened successfully", meeting });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

router.post(
  "/groups/:groupId/meetings/:meetingId/close",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      const meetingId = Number(req.params.meetingId);
      const cycleId = Number(req.body.cycleId);
      if (![groupId, meetingId, cycleId].every((value) => Number.isSafeInteger(value) && value > 0)) {
        return res.status(400).json({ success: false, message: "Valid group, meeting and cycle IDs are required." });
      }
      if (!req.user || String(req.user.groupId) !== String(groupId)) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      const meeting = await closeMeeting(groupId, cycleId, meetingId, req.user.id, auditMetaFor(req));
      res.status(200).json({ success: true, message: `Meeting #${meeting.meetingNumber} closed successfully.`, meeting });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Failed to close the meeting." });
    }
  },
);

router.post(
  "/meetings/:meetingId/transactions",
  verifyToken,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const meetingId = Number(req.params.meetingId);
      const groupId = Number(req.body.groupId);
      const cycleId = Number(req.body.cycleId);
      const memberId = Number(req.body.memberId);
      const { transactions } = req.body;

      if (!Number.isSafeInteger(meetingId) || meetingId <= 0) {
        return res.status(400).json({ success: false, message: "A valid numeric meeting ID is required. Please open a meeting session again." });
      }
      if (!req.user || String(req.user.groupId) !== String(groupId)) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      if (!Array.isArray(transactions)) {
        return res.status(400).json({ success: false, message: "Transactions array is required." });
      }

      const savedTransactions = await recordMeetingTransactions(
        groupId, cycleId, meetingId, memberId, transactions, req.user.id, auditMetaFor(req),
      );
      res.status(201).json({ success: true, message: "Transactions recorded successfully", transactions: savedTransactions });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

module.exports = router;
