"use strict";

const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const { payFineAssessment } = require("../services/fineService");

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

router.post(
  "/groups/:groupId/fines/:fineId/payments",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const groupId = Number(req.params.groupId);
      if (!req.user || Number(req.user.groupId) !== groupId) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      const payment = await payFineAssessment({
        fineId: req.params.fineId,
        groupId,
        cycleId: req.body.cycleId,
        meetingId: req.body.meetingId,
        memberId: req.body.memberId,
        amount: req.body.amount,
        recordedBy: req.user.id,
        auditMeta: auditMetaFor(req),
      });
      return res.status(201).json({ success: true, message: "Fine payment recorded successfully.", payment });
    } catch (error) {
      return sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "Could not record this fine payment." });
    }
  },
);

module.exports = router;
