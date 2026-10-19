# Itsinda VSLA - HTTP 400 fixes

## Changes made

- Fixed `Dashboard.jsx`: the member-management form was incorrectly rendered inside the sidebar button with `user="{user}"`, which passes a literal string instead of the logged-in user object. The form now lives in Leadership Terminal and receives `user={user}`.
- Added validation to member registration. Missing/invalid group IDs return a specific message, nonexistent groups return 404, and duplicate phone numbers return 409 rather than a generic server error.
- Removed the hard-coded cycle ID `1`. The dashboard now loads the active cycle belonging to the signed-in user's group.
- New groups now receive an initial active cycle during group registration. The group and cycle are inserted in one database transaction.
- Added an active-cycle endpoint and a one-time SQL migration for groups created before this fix.
- Updated share-out calculation to scope data to both group and cycle, preview completed cycles, return a meaningful empty result when no shares have been purchased, and use the response field names expected by the frontend.
- Corrected group settings parsing so a configured `shareValue` is not silently replaced with the default.

## Apply to an existing installation

1. Back up the `itsinda_db` database.
2. Run `backend/migrations/2026-10-17-ensure-active-cycle-per-group.sql` once against `itsinda_db`. It creates an active cycle only for groups that currently have none; it does not duplicate active cycles.
3. Replace the project files with the patched files in this archive.
4. Restart the backend, then rebuild/redeploy the frontend.
5. Sign out and sign back in if the browser has an old user object saved in local storage.

## Changed source files

- `frontend/src/components/Dashboard.jsx`
- `frontend/src/components/MemberManagement.jsx`
- `frontend/src/components/RegisterGroup.jsx`
- `frontend/src/components/ShareOutPreview.jsx`
- `backend/routes/authRoutes.js`
- `backend/routes/groupRoutes.js`
- `backend/routes/shareOutRoutes.js`
- `backend/services/shareOutService.js`
- `backend/migrations/2026-10-17-ensure-active-cycle-per-group.sql`

## Validation note

Backend JavaScript syntax checks passed. A frontend production build could not be run in this environment because the npm dependency installation did not complete, so rebuild the frontend in your normal development/deployment environment after replacing the files.


## Loan issuance `Unknown column 'NaN' in field list` fix

The loan issuance service used `loanRatioLimit`, `monthlyInterestRate`, and `maxLoanDurationMonths` from group settings, but the existing group-registration form only saved `shareValue`. Missing settings became JavaScript `NaN`, which reached the MySQL insert.

- Existing groups now receive fallback values in the loan service if these loan-rule keys are missing.
- New groups save the complete loan-rule settings when created.
- The loan service validates IDs, amounts, duration, due date, group membership, and active cycle before inserting the loan.
- No SQL migration is required for this particular fix; the code handles existing group records that do not have the settings keys.

**Important policy defaults:** where a group has not configured loan rules, this patch uses a 3x savings borrowing limit, a 0.05 monthly interest rate (5% per month), and a 12-month maximum duration. Confirm these match the group's agreed policy before using this build for real loans. Change `DEFAULT_LOAN_SETTINGS` in `backend/services/loanService.js` if the agreed terms differ.
