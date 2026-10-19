# Installation guide — Itsinda VSLA v14

## Before replacing your current version

1. Back up the current project source and `itsinda_db`.
2. Extract this ZIP into a new folder first. Keep your existing working folder until acceptance testing is complete.
3. Copy your working backend `.env` and frontend `.env` into the corresponding folders. Do not copy or commit real secrets into source control. Preserve your production JWT secret unless you intentionally want to invalidate existing sessions.
4. **No new database migration is needed** when upgrading from the v13 release that includes the prior migrations. Do not re-run migrations which have already succeeded.

## Run backend checks

From the project folder:

```bash
cd itsinda-backend
npm ci
npm run check:syntax
npm test
npm run dev
```

Check the health/readiness endpoint configured in your project before testing with the frontend.

## Build and run the frontend

Open a second terminal:

```bash
cd frontend
npm ci
npm run build
npm run dev
```

For local development, `VITE_API_BASE_URL` should point to `http://localhost:5000/api`. For an online deployment, change it to the backend's real HTTPS API URL and rebuild; Vite embeds this setting at build time.

## Acceptance test checklist

### Record feedback and persistence
1. Enter a member contribution. Confirm a green check appears with the server's saved message.
2. Enter an invalid contribution. Confirm a red X and useful reason appears; check that no transaction/ledger/receipt was added.
3. Simulate a lost network response carefully in staging. Confirm the amber status says the save is unknown and instructs the operator to check existing records before retrying.
4. Verify a successful write in the passbook, cashbook and/or receipt list after refreshing the page.

### Loan interest and repayments
1. Configure a 5% flat-per-period service charge with a 30-day period.
2. Issue a loan of RWF 10,000. Its initial service charge should be RWF 500 immediately.
3. Before the first full 30-day period, outstanding amount should include one RWF 500 charge.
4. On/after 30 completed days (for example day 32) and with no principal repayment, outstanding interest should show two charges, RWF 1,000 total.
5. Make a partial payment. The system applies the cash to interest due first, then the remaining amount reduces principal. The next period's flat charge is calculated on that reduced principal.
6. Confirm no split-exceeds-principal error is shown. A payment beyond total actual debt should still be rejected as an overpayment.

### Witness and reversals
1. Mark one member Present, one Absent and one Excused. Only the Present member should be offered as cash-count witness.
2. Attempt a witness ID tampered in the request from staging tools; the backend must reject it if the member is not marked Present in that meeting.
3. Choose a transaction reversal and confirm its dropdown identifies member, activity, amount, date and note. Already reversed entries and loan movements must not appear as generic reversal candidates.

### Meeting close and database persistence
1. Save notes and attendance.
2. Record contributions, any loan action, fine assessment/payment, and both physical cash counts with Present witnesses.
3. Close the meeting.
4. Confirm the success dialog says the meeting is closed and committed, and displays saved counts for transactions, cashbook entries, receipts, fine assessments, loans disbursed, cash reconciliations, attendance, notes and repayments.
5. Refresh the app and independently check the meeting status, cashbook, receipts, passbooks, attendance and audit history. The counts in the close dialog are read from the database within the close transaction; the success response is returned only after commit succeeds.

## Important notes

- A green tick means the server returned success after its write/transaction completed. An amber `Save status unknown` means the client lost the response; check the current database state before retrying to avoid duplicates.
- A close-time persisted-record count covers records associated with the selected meeting. Some cycle-level entries made before a meeting or records without a meeting ID are not included in that meeting's count.
- The closing record count is not a substitute for regular, off-host backups and periodic restore drills.
- A full production build and live database integration test still need to be run in your own environment before release.
