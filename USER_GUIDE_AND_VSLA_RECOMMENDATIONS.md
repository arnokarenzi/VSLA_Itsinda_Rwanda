# Itsinda VSLA — Project Guide and Recommended Improvements

## What the system currently does

Itsinda is a React/Vite frontend backed by an Express API and a MySQL/MariaDB database. The database separates groups, users, savings cycles, meetings, transactions, and loans.

### Main workflow

1. **Register a group** — `RegisterGroup.jsx` calls `POST /api/groups`. The backend creates the group and its first active cycle, and stores group settings such as the share value. The frontend then creates the first administrator account through `POST /api/auth/register`.
2. **Sign in** — `Login.jsx` sends the member's phone number and password to `/api/auth/login`. The backend verifies the password and returns a JWT token containing the user ID, group ID, and role. The frontend stores the user and token in local storage; `api.js` attaches the token to later requests.
3. **Load the dashboard** — `Dashboard.jsx` requests the group's active cycle, group totals, and the signed-in member's own savings, loans, and recent transactions. The overview is intended for all roles.
4. **Record group business** — authorized leadership roles use Leadership Terminal to register members, open meetings, record share purchases/social-fund contributions/fines, issue loans, and record repayments. The backend routes check the user's JWT, group membership, and role for management actions.
5. **View share-out** — `shareOutService.js` counts recorded share purchases by member and combines the group's saved base share value with interest recorded on the cycle and recorded fines. The current preview allocates that modeled profit pool per share. The Social Fund is excluded from the preview.

## Fix included in this version

The Share-Out Preview component was only rendered inside Leadership Terminal, while normal MEMBER accounts do not see the Leadership Terminal menu. The dashboard now has a separate **Share-Out Preview** tab available to every signed-in member. The view is read-only; the API still requires a valid token and restricts data to the signed-in user's group.

Changed file: `frontend/src/components/Dashboard.jsx`.

## Important financial limitation to fix before paying members

The current share-out calculation should be treated as a **preview, not a final payout ledger**. In the present implementation:

- Loan repayment updates the loan balance and records the repayment amount, but does not update `cycles.total_interest_collected`.
- A repayment transaction does not separate principal from service-charge/interest income.
- The share-out formula assumes saved capital plus recorded interest and fines are available; it does not reconcile cash on hand or block share-out while active loans remain outstanding.
- Loan issuance creates a `loans` record but does not also create a complete cash-movement ledger entry.

These gaps can make the displayed payout differ from the actual loan-fund cash. Before a real share-out, implement a reconciled cash ledger, allocate repayments between principal and service charge, track expenses/losses, require all loans to be repaid or formally written off, and compare preview totals with counted cash. Do not distribute money based only on the current estimate.

## Suggested roadmap, aligned with common VSLA practice

### Priority 1 — Trust and financial correctness

- **Complete cashbook**: record every inflow/outflow, with separate loan-fund and social-fund balances. Reconcile recorded balance against counted cash at each meeting.
- **Correct repayment allocation**: store each repayment's principal portion, service-charge portion, date, and receipt/reference. Update loan balances and cycle profit in one database transaction.
- **Safe share-out workflow**: warnings for outstanding loans, defaults, approved expenses and discrepancies; then a formal close-cycle process, a frozen member-by-member payout statement, approval/sign-off, recorded cash paid, and a new cycle.
- **Do not mix the Social Fund with the loan fund**. Track social-fund contributions, grants/payments, eligibility and carried balance separately; normally it remains separate from the share-out unless the group's constitution specifically says otherwise.
- **Double-entry-style audit trail or immutable event ledger**: don't silently edit/delete transactions. Corrections should create a reversal and replacement with who/when/why.

### Priority 2 — Enforce the group's constitution

- Capture the agreed share price, share purchase minimum/maximum, meeting schedule, fine rules, loan service charge, maximum loan amount, loan term, grace/late rules, and social-fund rules in group settings.
- Require the group to confirm and approve its constitution settings. Defaults should be clearly shown as examples, not treated as the group's actual rules.
- Validate share purchases at the backend, including any agreed 1–5 shares-per-meeting limit if the group adopts that standard.
- Make loan requests, group approval, available cash checks, member savings limit checks, disbursement, repayment schedule and delinquency tracking explicit.
- Add cycle-end controls to stop new loans in the final 1–2 months if the group adopts that practice, and require outstanding loans to be settled before final share-out.

### Priority 3 — Governance and usability

- Add meeting attendance, minutes, decisions/votes, and elected committee roles (chairperson, record-keeper/secretary, box-keeper/treasurer, money counters/key holders as the group needs).
- Add a member passbook/statement with date, meeting, shares, all payments, loans, repayments, balance, and printable/PDF export.
- Give members easy access to their own statements plus the agreed group-level report; limit access to another member's personal loan details based on the group's transparency rules.
- Support Kinyarwanda and English, mobile-first pages, low-data operation, and printable meeting summaries for groups with intermittent connectivity.
- Add reminders for meetings, repayment due dates and end-of-cycle steps, but never treat a notification as proof that a payment was received.

### Priority 4 — Reliability and security

- Use strong environment-only JWT secrets, shorter session lifetimes/refresh strategy, HTTPS in deployment, strict CORS, rate limiting, and password reset/change flows.
- Check group ID, cycle ID, meeting ID and member ID relations within each backend operation; do not trust IDs merely because the frontend sent them.
- Add automated tests for role permissions, group isolation, partial repayments, duplicate submissions, rollback failures, rounding, and share-out totals.
- Schedule database backups and periodically test restoring one. Log important actions without storing passwords or sensitive data in logs.

## VSLA rules vary

Typical VSLA guidance commonly describes a self-managed group, regular meetings, shares, loans generally capped at three times member savings and terms up to three months, a separate social fund, and a cycle-end share-out proportional to members' shares. However, each group should operate according to its own constitution and member-approved rules. Do not enforce a generic rule without confirming it with the group.

## Financial foundation update

For the cashbook ledger, principal/interest repayment split, physical cash reconciliation and guarded share-out improvements, see `FINANCIAL_FOUNDATION_V5.md`. Run `backend/migrations/2026-10-18-fund-ledger-reconciliation.sql` once after backing up the database; it is not safe to re-run as a second migration.
