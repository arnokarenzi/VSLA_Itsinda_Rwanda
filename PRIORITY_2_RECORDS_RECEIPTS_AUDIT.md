# Itsinda VSLA — Priority 2: Meeting Records, Receipts and Audit Trail

This update builds on the working v6 meeting and financial foundation. It adds documented meeting records, attendance, printed financial receipts, leadership audit history, and append-only correction entries.

## Before you update

1. Back up the project folder and the `itsinda_db` database.
2. Confirm that the v5 financial-ledger migration was already applied and that v6 is working against this database.
3. Stop the backend before applying the new migration.

## Database migration

Run this migration **once only**, after the v5 financial-ledger migration:

`backend/migrations/2026-10-18-priority-2-records-receipts-audit.sql`

Do not rerun the migration after it succeeds. It alters the existing `transactions` and `fund_ledger_entries` tables and creates `meeting_records`, `meeting_attendance`, `financial_receipts`, and `audit_logs`.

The migration preserves existing financial transactions. It does not create receipts or audit events retroactively for historical activity, and it does not invent any missing historical data.

## Deploy the source

1. Extract this project version into a separate folder first, so you can roll back to v6.
2. Preserve the existing `.env` file and database credentials.
3. Apply the SQL migration above to the same database used by the backend.
4. Replace/update the project files with those in this ZIP; do not overwrite `.env`.
5. In `backend`, run `npm install` if needed, then `npm test`, and start the backend using the project's normal command.
6. In `frontend`, install dependencies if needed and run the normal production build before deploying or replacing the live frontend.

## What changed

- **Meeting records:** leadership can save agenda, minutes, decisions, follow-up action items, and attendance for an open meeting. Members can view the saved records. Notes and attendance are locked after meeting closure.
- **Receipts:** newly recorded member contributions, loan disbursements, repayments, cashbook opening balances, expenses, documented adjustments, and eligible financial reversals generate a persistent receipt in the same database transaction as the source movement. Receipts can be printed or saved as PDF from the browser.
- **Receipt permissions:** members can see only receipts whose `member_id` belongs to them. Leadership roles can review group receipts.
- **Audit trail:** leadership can review important actions, who performed them, when they happened, the stated reason, and the recorded before/after data. New audit events start from this version; old activity is not backfilled into a fictitious history.
- **Corrections:** supported eligible entries are corrected by appending a reversal, not deleting or silently editing the original. Enter a clear reason, reconcile the cashbook, and record the correct replacement through the normal form.
- **Loan safety:** loan disbursements and repayments cannot be reversed through the generic correction form, because that would corrupt loan balances. A loan-specific correction workflow should be implemented separately before correcting such transactions.

## Recommended acceptance test

Use a test group or a database backup, not live member funds:

1. Open a meeting and save the agenda, minutes, decisions, action items, and attendance.
2. Sign in as a member and confirm the meeting notes are visible but read-only.
3. Record a share purchase and confirm a receipt is generated; check that the member sees their own receipt.
4. Sign in as leadership and confirm group receipts and the matching audit event are visible.
5. Record a test expense or eligible contribution, then use the reversal form with an explanatory reason. Confirm that the original remains, a reversal entry and receipt exist, an audit event is present, and the balance reflects the net movement.
6. Confirm a member cannot read another member's receipt or the group audit log.
7. Confirm loan entries are not offered for generic reversal.

## Validation status

Backend syntax checks, six backend unit tests, and JSX syntax-transpilation checks passed in the working environment. A full frontend production build and a live MySQL integration test were not run. Test the migration on a backup database before applying it to the operational database.
