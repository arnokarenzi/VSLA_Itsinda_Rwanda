# Itsinda VSLA v12 — contribution rules, fines and cash-count witnesses

This release builds on v11.1 and makes the meeting rules enforceable in both the interface and the backend.

## Important first step: database migration

1. Stop the backend before deploying the new code.
2. Back up the database. At minimum, create a SQL dump of `itsinda_db` before changing its schema.
3. Confirm that the v5 fund-ledger, Priority 2 records/receipts/audit and Priority 3 constitution migrations were already completed.
4. Check whether the schema objects added by `itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql` already exist:

   ```sql
   SHOW TABLES LIKE 'fine_assessments';
   SHOW COLUMNS FROM transactions LIKE 'fine_assessment_id';
   SHOW COLUMNS FROM cash_reconciliations LIKE 'witness_member_id';
   ```

5. If all three exist, do not rerun the migration. If none exist, run it once from the project root:

   ```bash
   mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql
   ```

   Enter the DB password when prompted. If only some objects exist, stop and inspect the database before proceeding; the migration is not designed for a partially applied rerun.

6. Replace the source code with this release, but keep your local `itsinda-backend/.env` and `frontend/.env` files. Do not replace them with examples.
7. In one terminal, run `cd itsinda-backend && npm ci && npm run check:syntax && npm test && npm run dev`. In another terminal, run `cd frontend && npm ci && npm run dev`.

## Fixed Social Fund contributions

If the current approved constitution uses `FIXED` mode and says 100 RWF per meeting:

- In Meeting Records, mark each active member as **Present**, **Absent**, or **Excused** before closing the meeting.
- A member marked Present must have a total of exactly 100 RWF in Social Fund contributions for the meeting. A submission with zero, a partial amount, or more than 100 is rejected by the backend.
- Members marked Absent or Excused are exempt and cannot be charged through this fixed contribution rule.
- A present member who already paid exactly 100 earlier in that meeting can record another share purchase or a fine assessment without paying another 100. Leave the Social Fund input blank in that later submission; the server verifies the amount already recorded.
- A meeting cannot close under a fixed Social Fund rule if an active member's attendance is unrecorded, or a present member's total is not exactly the configured amount. The two physical fund reconciliations must still match as before.

This gives the rule a final meeting-level check as well as transaction-time validation. Reversed contributions do not count as paid because only posted Social Fund transactions are counted.

## Minimum shares per meeting

In **Constitution & Rules**, the minimum share count accepts 0, 1, or any supported whole-number value. If the minimum is 1, a member recording contribution activity must meet at least one share during that meeting. If it is 0, a Social Fund contribution can be recorded with no shares. Previously recorded shares in the same meeting are included when validating a later separate Social Fund contribution.

A fine assessment on its own is a debt event, not a share purchase. It does not itself count as purchased shares. However, if Social Fund mode is FIXED and the member is Present, a fine-only submission still requires that the exact Social Fund amount has already been paid or is included in the same submission.

## Fines: assess first, collect when paid

1. In **Meeting Operations & Contributions**, select a member and choose a named item from **Assess a Fine**. The amount comes from the approved constitution; the frontend cannot change it.
2. If **Allow other fines not listed above** is enabled, `Other` appears. For that option only, enter the reason and amount.
3. Recording a fine creates an outstanding fine liability. It does not create cash income or a cash receipt because no money has been collected yet.
4. To collect it, go to Loan Management, select the borrower, then select that fine under **Outstanding Loan or Fine**. Enter the actual amount received and submit. The fine's balance updates, the payment enters the Loan Fund cashbook and a receipt is issued.
5. A fine is displayed as a separate obligation alongside loans, not added to the loan principal. This keeps fine balances auditable and prevents interest from being charged on a fine as though it were loan principal.

## Cash-count witness

In **Cashbook & Reconciliation**, choose a currently active group member from the Witness dropdown before saving a physical count. The witness member ID and name are stored with the reconciliation. Earlier counts are not assigned a witness retrospectively; those show as a historic count with no witness recorded.

## Difference between cash corrections

### Document Cash Adjustment

Use this after investigating a real cash difference or to document approved opening/carried-forward cash. It creates a **new** IN or OUT cashbook entry. It does not cancel or correct a particular old transaction. Choose the correct treatment:

- `BALANCE_CORRECTION`: corrects the recorded cash balance without changing profit.
- `OTHER_INCOME_OR_LOSS`: records an unexplained cash gain or loss and affects the Loan Fund result.

Use a specific description explaining the cause, investigation and approval. Do not use an adjustment simply to cover up a wrong transaction.

### Correct a Financial Entry (Reversal)

Use this when a **specific eligible existing entry is wrong**. The system records an equal-and-opposite entry linked to the original, preserving the original record and audit trail. Then record the correct replacement through the normal workflow and count cash again. Generic reversals intentionally exclude loan disbursements and loan repayments because those require loan-balance-specific correction.

**In one sentence:** adjustment documents a newly recognized cash difference; reversal cancels the effect of a specific erroneous entry. They are not interchangeable.

## Test checklist

- Set fixed Social Fund = 100 RWF and test Present member submissions of 0, 50, 100 and 150; only the exact 100 should satisfy the rule when not previously paid.
- Record 100 once, then record that member's shares in a second submission; it should not request a second payment.
- Mark a member Absent or Excused, and verify they are exempt from the fixed payment.
- Try to close a fixed-Social-Fund meeting without recording every active member's attendance or with a Present member short/over by any amount; closure should be blocked.
- Set minimum shares to 0 and verify a social contribution with zero shares is allowed. Set the minimum to 1 and verify a contribution submission with zero cumulative shares is rejected.
- Assess a named fine and verify the constitution amount is applied. Test `Other` with it enabled and disabled.
- Pay an assessed fine from the Outstanding Loan or Fine selector and verify its balance, receipt and cashbook inflow.
- Choose a witness, save a reconciliation, and verify the witness name appears in Cashbook.
- Compare a documented adjustment with a reversal on a test-only entry; the first adds a new cash movement, while the second reverses a specific eligible entry.
