# Itsinda VSLA v14 — Save Confirmation, Loan Interest, Reconciliation Witnesses

## What's changed

### 1. Save confirmation for records
- All API write requests (POST, PUT, PATCH and DELETE), except sign-in, now display a global result dialog.
- A green check means the server returned a successful result. For transactional financial routes, the response is sent only after the database transaction has committed.
- A red X shows a server-reported failure and the server's validation message.
- If the browser loses connection before receiving a response, an amber `Save status unknown` message asks the operator to check the current records before retrying. The request might have committed even if the response was lost; blindly retrying could duplicate it.

### 2. Interest starts immediately
- `FLAT_ONCE`: one flat service charge is due when the loan is issued.
- `FLAT_PER_PERIOD`: one charge is due at issuance, plus another charge for each completed period of the constitution's configured length in days.
- Example: principal RWF 10,000, rate 5%, period 30 days. The initial charge is RWF 500. On day 3, one charge is due. At 30 completed days (and therefore by day 32), two charges are due, or RWF 1,000 if principal has not been reduced.
- Each later charge uses principal still outstanding at that point. Interest does not compound on unpaid interest. A previous partial payment reduces future charges only to the extent it reduced principal.
- The app's outstanding-loan response projects any elapsed-but-not-yet-posted charge; the repayment transaction persists new accruals together with the repayment, ledger entries, receipt and audit event.

### 3. Repayment from received cash
- Operators enter the cash amount received, not a principal/interest split.
- The backend allocates received cash to interest outstanding first, then principal outstanding. It no longer throws `The repayment split exceeds the borrower's remaining principal` due to an invalid derived split.
- A payment greater than the total outstanding loan debt is still rejected; this protects against accidental overpayment. Fine payments stay on the fine-assessment payment route and are not treated as loan principal.

### 4. Cash-count witness
- Only active group members recorded as `PRESENT` in the selected open meeting are offered in the witness dropdown.
- The backend rechecks the same condition while saving each cash count. Meeting closure revalidates both witnesses against the final attendance register.

### 5. Reversal descriptions
- The reversal dropdown uses the full eligible list for the active cycle, not just the most recent 30 entries.
- Options identify the member (where applicable), transaction activity, share count or fine reason, direction, amount, date and note.
- A detail panel describes the selected original record. Already reversed entries and loan disbursements/repayments are excluded from the generic reversal path.

### 6. Meeting closure: persisted-record receipt
- Each transactional write route commits its transaction before returning success.
- Meeting closure occurs in a single database transaction. Automatic absence-fine assessments, the status change to `CLOSED`, and the `MEETING_CLOSED` audit event commit together. If a validation or commit fails, the transaction rolls back and the server does not return a successful close response.
- Before commit, the service counts the meeting's database rows for transactions, cashbook entries, receipts, fine assessments, attendance, meeting notes, cash reconciliations, loan disbursements and loan repayments. Those counts are stored in the close audit event and included in the success dialog after commit.
- The count is a confirmation of rows persisted for that meeting, not a database backup or hardware-durability guarantee. Continue making and testing regular database backups.

## Database migrations

No new schema migration is required for v14. It relies on the existing v12/v13 schema, including the fund-ledger, receipts/audit, group-constitution, fine-assessment/cash-witness and Gusibuza/loan-day-period migrations. Do not rerun migrations that have already succeeded.

## Validation performed

- Backend syntax check passed: 45 JavaScript files.
- Backend tests passed: 60/60.
- Frontend JS/JSX syntax transpilation passed: 15/15 source files using the installed TypeScript transpiler.
- A full Vite production build and live database integration test were not performed in this environment; run them locally before production deployment.
