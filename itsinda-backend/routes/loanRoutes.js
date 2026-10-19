const express = require("express");
const router = express.Router();
const { sendRouteError } = require("../utils/routeErrors");
const { issueLoan, repayLoan, getOutstandingLoans } = require("../services/loanService");
const { getOutstandingFines } = require("../services/fineService");
const { verifyToken, requireRole, verifyGroupOwnership } = require("../middleware/auth");
const auditMetaFor = (req) => ({ ipAddress: req.ip, userAgent: req.get("user-agent") });

const LEADERSHIP_ROLES = ["TREASURER", "SECRETARY", "CHAIRPERSON", "ADMIN"];


router.get(
  "/groups/:groupId/loans/outstanding",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { cycleId, memberId } = req.query;
      const loans = await getOutstandingLoans(groupId, cycleId, memberId);
      const fines = await getOutstandingFines(groupId, cycleId, memberId);
      return res.status(200).json({ success: true, loans, fines });
    } catch (error) {
      return sendRouteError(res, error, {
        fallbackStatus: 400,
        fallbackMessage: "Could not load outstanding loans for this borrower.",
      });
    }
  },
);

router.post(
  "/groups/:groupId/loans",
  verifyToken,
  verifyGroupOwnership,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { cycleId, memberId, principalAmount, meetingId } = req.body;
      const loan = await issueLoan(
        groupId, cycleId, memberId, principalAmount, meetingId, req.user.id, auditMetaFor(req),
      );
      res.status(201).json({ success: true, message: "Loan issued successfully", loan });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

router.post(
  "/loans/:loanId/repay",
  verifyToken,
  requireRole(LEADERSHIP_ROLES),
  async (req, res) => {
    try {
      const { loanId } = req.params;
      const { repaymentAmount, cycleId, meetingId, groupId, memberId } = req.body;
      if (!req.user || String(req.user.groupId) !== String(groupId)) {
        return res.status(403).json({ success: false, message: "Access forbidden. Group ID mismatch." });
      }
      const repayment = await repayLoan(
        loanId,
        repaymentAmount,
        cycleId,
        meetingId,
        groupId,
        req.user.id,
        auditMetaFor(req),
        memberId ?? null,
      );
      res.status(200).json({ success: true, message: "Loan repayment recorded successfully", repayment });
    } catch (error) {
      sendRouteError(res, error, { fallbackStatus: 400, fallbackMessage: "The request could not be completed." });
    }
  },
);

module.exports = router;
