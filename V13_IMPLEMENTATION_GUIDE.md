# Itsinda VSLA v13 — Gusibuza, Day-Based Loans, Attendance and Meeting Operations

This release builds on the v12 rules, financial ledger, receipts, digital passbook, constitution voting, and security controls.

## What's changed

### 1. Gusibuza (late share purchase)

- Leadership must enable Gusibuza in the member-approved constitution.
- The group must define a **positive maximum shares per member per meeting** and a positive fee amount.
- The fee method is either:
  - **Per share**: fee amount × number of late shares purchased.
  - **Per target meeting**: one fixed fee per member for each earlier meeting being topped up. If the member later buys more shares for that same target meeting, the fee is not charged a second time.
- A member must be marked **Present** in the current open meeting to make a Gusibuza purchase.
- The original target meeting must be earlier than the current meeting and already closed. The current meeting must be open in the active cycle.
- The member must first meet the current meeting's minimum regular share purchase and, where Social Fund is fixed, pay that meeting's exact required Social Fund contribution.
- The late shares are credited to the **original target meeting** for meeting share totals and share limits. The cash and any fee are received/recorded in the **current open meeting**. This preserves the date when the money was received while correcting the old meeting's share count.
- The fee is group income, not member savings, and the passbook labels it separately.

Example: If Meeting 1 allows at most 4 shares and a member purchased 3, after Meeting 1 is closed they can buy the missing 1 share during Meeting 2. The 1 share increases Meeting 1's credited share total, but the actual money is recorded as received in Meeting 2.

### 2. Loan issuance and interest

- A loan can be issued only while the selected meeting is **OPEN** and after the Loan Fund has a current, balanced physical cash reconciliation for that meeting.
- The borrower does not enter a term or due date. The backend calculates an expected due date from the approved constitution's period in days.
- The constitution offers two interest/service-charge methods:
  - **One-time flat rate per loan**: calculate the approved rate once against the original principal at issuance.
  - **Flat rate for every set period (days)**: for every completed period, calculate interest using the principal that remains outstanding. Interest does not compound on previously charged interest.
- The `interestPeriodDays` and `maxLoanTermDays` constitution values must match. The period also determines the expected due date.
- Partial payments settle accrued interest first. Any remaining payment reduces principal. Future periods charge interest on that reduced principal. A payment smaller than already-accrued interest will reduce the unpaid interest, not principal; in that case, the principal and future interest base do not decrease yet.
- Loans issued before the day-based fields were added retain legacy behaviour where `interest_method` is `NULL`. They are not silently recalculated. Review old loans separately with the group's agreed rules.

Example, periodic method: RWF 10,000 principal at 5% per 30-day period. If the member pays RWF 600 after the first 30-day period, RWF 500 pays accrued interest and RWF 100 reduces principal. The remaining principal is RWF 9,900, so the next completed 30-day period adds RWF 495 interest (5% × 9,900), not RWF 500.

### 3. Attendance and meeting transactions

- Attendance options are **Present**, **Absent**, and **Excused**. A blank placeholder is not a saved status.
- An excuse reason is required when status is **Excused**.
- Meeting Operations & Contributions only offers members marked **Present**. A present member's current-meeting summary is displayed after selection.
- **Absent without excuse** is assessed automatically as an outstanding fine when the meeting is closed. It must be configured in the approved constitution, and it is not available in the manual fine dropdown. If someone is absent and the automatic fine is missing from the constitution, the meeting cannot close until the rule is configured and approved.
- An automatic or manually assessed fine is a debt only. It is not cash collected until paid.
- The existing fixed Social Fund rule remains enforced: a present member must contribute exactly the configured amount in the meeting. Absent/excused members are exempt.

## Installation / upgrade

1. Back up the project and `itsinda_db` database before replacing any files.
2. Replace the source files with this release. Preserve backend and frontend `.env` files and your database credentials; do not overwrite secrets with example values.
3. There is **no new database migration specifically for v13**. The new Gusibuza and loan-period code depends on the v12 migration `itsinda-backend/migrations/2026-10-19-gusibuza-and-loan-day-periods.sql` having already run. It adds `transactions.credited_meeting_id`, the `GUSIBUZA_FEE` transaction type, and day-based loan fields. If you already upgraded to v12 and applied it successfully, do not run it again.
4. To check those fields before deploying, run:

   ```sql
   SHOW COLUMNS FROM transactions LIKE 'credited_meeting_id';
   SHOW COLUMNS FROM loans LIKE 'interest_method';
   SHOW COLUMNS FROM loans LIKE 'interest_period_days';
   SHOW COLUMNS FROM loans LIKE 'interest_periods_charged';
   SHOW COLUMNS FROM transactions LIKE 'type';
   ```

   Inspect the `type` column's enum and confirm it includes `GUSIBUZA_FEE`. If only some fields exist, do not rerun the whole migration; reconcile the schema manually or from a verified backup.
5. In the constitution form, set a maximum shares per meeting before enabling Gusibuza. The minimum can be `0`; regular recorded share purchases still must be positive whole-share counts.
6. Configure and obtain member approval for the `Absence without excuse` fine rule if the group wants the automatic absence fine at meeting close.
7. Run backend tests and syntax checks:

   ```bash
   cd itsinda-backend
   npm ci
   npm test
   npm run check:syntax
   ```

8. Install and build the frontend, then run a staging test before production:

   ```bash
   cd ../frontend
   npm ci
   npm run build
   ```

## Acceptance test checklist

### Gusibuza

- Configure a max of 4 shares; member purchases 3 in Meeting 1.
- Close Meeting 1, open Meeting 2, mark member Present and satisfy regular shares / fixed Social Fund rules.
- Record 1 late share targeting Meeting 1; verify Meeting 1 credited shares become 4, Meeting 2 cashbook records the received share money, and both receipts are generated where applicable.
- Try adding a 2nd late share to the same target; it should be rejected because the cap is reached.
- With `PER_SHARE`, test the fee scales with share count. With `PER_MEETING`, test a second batch for the same target has no duplicate fixed fee.
- Ensure a late-share fee appears in the passbook as a fee, not as savings.

### Loans

- Attempt loan issuance before a Loan Fund count: it should be rejected.
- Reconcile a matching Loan Fund physical count on the currently open meeting, then issue a loan; it should be accepted and the meeting should stay open.
- Verify the form has no borrower-entered term or due-date field.
- For periodic terms, test that a period accrues only after its configured number of days and that partial payment principal reduces the interest base for subsequent periods.
- Verify previous legacy loans have not silently changed.

### Attendance and contribution form

- Mark a member Present, Absent, and Excused in turn. Only Present members should appear in Meeting Operations.
- Save Excused without a reason: it should be rejected. Save with a reason: it should be accepted.
- Close a meeting containing an Absent member; verify the constitutional absence fine is assessed once, as an outstanding debt, without a cash receipt.
- Verify the manual fine dropdown does not offer the automatic absence fine.
- Select a Present member and compare the displayed current-meeting summary with recorded transactions and receipts.
- With fixed Social Fund, a Present member must pay the exact set amount; absent/excused members are exempt.

## Validation note

Backend unit tests pass in the packaged source, backend JavaScript syntax checks pass, and all frontend JavaScript/JSX files were parsed/transpiled for syntax. A full Vite production build and live MySQL integration test were not completed in this environment because frontend dependency installation timed out. Run them locally against a backed-up or staging database before production use.
