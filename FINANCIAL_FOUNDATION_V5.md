# Itsinda VSLA — Financial Foundation (Priority 1)

This version improves the cashbook, loan accounting and share-out calculation. It is a source-code patch and database migration; it has not been tested against a live copy of your production database.

## What changed

- Added `fund_ledger_entries` as an auditable cash movement ledger for the Loan Fund and Social Fund separately.
- Added `cash_reconciliations` to save the book balance, physically counted cash, variance and ledger snapshot at the time of counting.
- Historical share purchases, fines, social-fund contributions and loan repayments are carried into the ledger by a migration. Historical loan disbursements are backfilled from the existing `loans` table.
- New share purchases, fines and social-fund contributions create their transaction record and ledger movement in one database transaction.
- Share-purchase amount is server-validated against `shares_count × the group share value`.
- Loan disbursements reduce Loan Fund cash and are linked to the meeting. The backend requires a previously balanced physical cash count and refuses disbursement greater than the cashbook balance. Expenses also require a previously balanced count and cannot exceed the recorded fund balance.
- New repayments are allocated to outstanding interest first and then principal. The transaction records the split and the cashbook stores both components. Overpayments above the remaining loan balance are rejected.
- Group expenses and Social Fund benefits are recorded against their own funds. Expenses cannot exceed the cashbook balance.
- Physical cash counts are saved as reconciliations; a difference is never silently posted as an adjustment.
- Share-out payout amounts use reconciled physical Loan Fund cash only. They do not add the Social Fund, assume that unpaid loans are cash, or automatically treat savings plus recorded profit as cash.
- Final payout figures remain unavailable until there are recorded shares, share-purchase amounts match the share price, no loan balance remains, and both funds have current reconciliations with no variance.
- Payout rounding is deterministic and each member's payout rows add up exactly to the reconciled distributable cash.

## Apply safely

1. **Back up the database first.** For example:

   ```bash
   mysqldump -u root -p itsinda_db > itsinda_db_before_financial_foundation.sql
   ```

2. Stop the backend so no new financial transactions occur during the migration.

3. Run this migration **once only** against the same database configured in your backend `.env`:

   `backend/migrations/2026-10-18-fund-ledger-reconciliation.sql`

   For a local MySQL/MariaDB terminal:

   ```bash
   mysql -u root -p itsinda_db < backend/migrations/2026-10-18-fund-ledger-reconciliation.sql
   ```

   Or open phpMyAdmin, select `itsinda_db`, open the SQL/import tool, and run the migration file. Do not run it a second time: it includes `ALTER TABLE` statements and is intended for a one-time upgrade.

4. Replace your local project with the files in this ZIP, preserving `.env` and other machine-specific secrets. Do not overwrite your real `.env` with an example file.

5. In `backend`, install dependencies if needed (`npm ci`) and start the server (`npm run dev`). In `frontend`, install dependencies if needed (`npm ci`) and run `npm run dev` or your usual build/deploy process.

6. Check that `GET /api/groups/<groupId>/cycles/<cycleId>/cashbook` returns a successful report after you sign in. If it says the migration is missing, check that the migration was run in the database named in `.env`.

## First reconciliation of an existing group

The migration can restore only amounts already present in the old database. It cannot invent cash that was carried over from a previous cycle, cash expenses that were never recorded, or an old physical count.

1. Open **Leadership Terminal** and open a meeting for the active cycle.
2. Open **Cashbook & Reconciliation**.
3. Review the backfilled Loan Fund and Social Fund entries and the warning about historical repayments.
4. Physically count Loan Fund cash and record it under **Count and Reconcile Physical Cash**.
5. Count Social Fund cash separately and record it under the Social Fund option.
6. If there is a variance, investigate receipts, old loan records, carry-forward cash and missing expenses first. If a ledger correction is justified, use **Document Cash Adjustment**, enter the reason/approval, and choose the correct accounting treatment. Recount and reconcile again afterward. The application does not auto-correct a difference.
7. Do not use the share-out figures as final unless the preview says it is ready for final distribution.

The existing cycle may already have ledger entries, so the one-time **Record Opening Cash** form will reject adding an opening balance to that same fund/cycle. For cash genuinely carried into an already populated cycle, reconcile the records and use a documented balance correction instead of duplicating the old transactions as an opening balance.

## Use the cashbook for future meetings

- Record share purchases, fines and Social Fund contributions through **Meeting Operations**; the app also creates their cashbook entries.
- Issue loans and record repayments against an open meeting. Loan issuance becomes a cash outflow; each repayment is split into principal and interest.
- Record operating expenses against the Loan Fund and member benefits against the Social Fund, with a description/receipt reference.
- After every meeting, physically count the two funds separately and save both reconciliations. If more entries occur after a count, that reconciliation becomes stale and must be repeated.
- Before share-out, settle all loans or resolve them through a formally approved process supported by recorded accounting entries; this code intentionally blocks a final payout while any loan balance remains.

## Historical repayment limitation

The former `transactions` schema stored a repayment as one total amount and did not link it to a specific loan or separate principal from interest. The migration therefore includes those amounts in cash as `LEGACY_REPAYMENT`, but does not guess how much was interest. The preview shows a warning. Check historic receipts and loan records before relying on historical interest/profit totals. New repayments record the split going forward.

The current repayment allocation rule is **interest first, then principal**, reconstructed from the old loan's `total_amount_due - balance_remaining` for partially repaid loans. If your group constitution requires a different repayment order, change the rule before using this version for real lending.

## Validation performed here

- Backend JavaScript syntax checks passed.
- `npm test` passed three share-out allocation tests, including exact cent reconciliation.
- The modified JSX files passed TypeScript transpilation checks.
- A full frontend production build and live MySQL integration test were not run because dependency installation timed out in this environment. Test the migration on a copy of the database before applying it to your primary database.
