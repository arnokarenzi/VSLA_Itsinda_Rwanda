const db = require("../config/db");

/**
 * Fetch a member's financial dashboard summary (shares, savings value, active loans)
 */
async function getMemberDashboard(groupId, memberId, cycleId) {
  const connection = await db.getConnection();

  try {
    // 1. Fetch group settings for share value calculation
    const [groupRows] = await connection.query(
      "SELECT settings FROM `groups` WHERE id = ?",
      [groupId],
    );
    if (groupRows.length === 0) throw new Error("Group not found");

    let settings = groupRows[0].settings;
    if (typeof settings === "string") settings = JSON.parse(settings);
    const shareValue = Number(settings.shareValue);

    // 2. Fetch total shares for this member in the specified cycle
    const [shareRows] = await connection.query(
      `SELECT SUM(shares_count) AS total_shares 
       FROM transactions 
       WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'`,
      [groupId, cycleId, memberId],
    );
    const totalShares = Number(shareRows[0].total_shares || 0);
    const totalSavings = totalShares * shareValue;

    // 3. Fetch active loans for this member
    const [loanRows] = await connection.query(
      `SELECT * FROM loans WHERE group_id = ? AND cycle_id = ? AND member_id = ? AND status = 'ACTIVE'`,
      [groupId, cycleId, memberId],
    );

    // 4. Fetch recent transactions for this member
    const [txRows] = await connection.query(
      `SELECT * FROM transactions WHERE group_id = ? AND cycle_id = ? AND member_id = ? ORDER BY created_at DESC LIMIT 10`,
      [groupId, cycleId, memberId],
    );

    connection.release();

    return {
      memberId: Number(memberId),
      cycleId: Number(cycleId),
      totalShares,
      totalSavings,
      activeLoans: loanRows,
      recentTransactions: txRows,
    };
  } catch (error) {
    connection.release();
    throw new Error(`Failed to fetch member dashboard: ${error.message}`);
  }
}

/**
 * Fetch group-level macro financial summary for a cycle
 */
async function getGroupDashboard(groupId, cycleId) {
  const connection = await db.getConnection();

  try {
    // 1. Total savings pooled (Total shares across all members * share value)
    const [groupRows] = await connection.query(
      "SELECT settings FROM `groups` WHERE id = ?",
      [groupId],
    );
    if (groupRows.length === 0) throw new Error("Group not found");

    let settings = groupRows[0].settings;
    if (typeof settings === "string") settings = JSON.parse(settings);
    const shareValue = Number(settings.shareValue);

    const [shareRows] = await connection.query(
      `SELECT SUM(shares_count) AS total_shares FROM transactions WHERE group_id = ? AND cycle_id = ? AND type = 'SHARE_PURCHASE' AND status = 'POSTED'`,
      [groupId, cycleId],
    );
    const totalGroupShares = Number(shareRows[0].total_shares || 0);
    const totalGroupSavings = totalGroupShares * shareValue;

    // 2. Total Social Fund collected
    const [socialRows] = await connection.query(
      `SELECT SUM(amount) AS total_social FROM transactions WHERE group_id = ? AND cycle_id = ? AND type = 'SOCIAL_FUND' AND status = 'POSTED'`,
      [groupId, cycleId],
    );
    const totalSocialFund = Number(socialRows[0].total_social || 0);

    // 3. Total Fines collected
    const [fineRows] = await connection.query(
      `SELECT SUM(amount) AS total_fines FROM transactions WHERE group_id = ? AND cycle_id = ? AND type = 'FINE_PAYMENT' AND status = 'POSTED'`,
      [groupId, cycleId],
    );
    const totalFines = Number(fineRows[0].total_fines || 0);

    // 4. Active Loans summary
    const [loanRows] = await connection.query(
      `SELECT COUNT(*) AS active_loans_count, SUM(balance_remaining) AS total_outstanding_balance 
       FROM loans WHERE group_id = ? AND cycle_id = ? AND status = 'ACTIVE'`,
      [groupId, cycleId],
    );

    connection.release();

    return {
      groupId: Number(groupId),
      cycleId: Number(cycleId),
      totalGroupShares,
      totalGroupSavings,
      totalSocialFund,
      totalFines,
      activeLoansCount: Number(loanRows[0].active_loans_count || 0),
      totalOutstandingBalance: Number(
        loanRows[0].total_outstanding_balance || 0,
      ),
    };
  } catch (error) {
    connection.release();
    throw new Error(`Failed to fetch group dashboard: ${error.message}`);
  }
}

module.exports = { getMemberDashboard, getGroupDashboard };
