# Itsinda VSLA — Complete Setup Guide

This guide explains how to run the uploaded Itsinda VSLA project locally, configure the environment files, create a JWT signing secret, connect MySQL/MariaDB, apply migrations safely, test loan repayments, and prepare the app for deployment.

## 1. Requirements

- **Node.js:** use Node 22 LTS (Vite in this project's lockfile requires Node `^20.19.0` or `>=22.12.0`).
- **npm:** included with Node.js.
- **MySQL or MariaDB:** the project uses `mysql2`; the supplied historical schema was created with MariaDB 10.4. Use a supported MySQL/MariaDB release and test migrations on a backup first.
- A terminal such as PowerShell, Terminal, Bash, or VS Code's terminal.

After installation, verify:

```sh
node --version
npm --version
mysql --version
```

## 2. Understand the project folders

- `frontend/` — React + Vite browser application.
- `itsinda-backend/` — Express API, authentication, business logic and SQL migrations.
- `database/000-base-schema.sql` — baseline tables for a new, empty database only.
- `itsinda-backend/migrations/` — one-time schema upgrades used by the application.
- `itsinda-backend/.env.example` — safe template for backend settings.
- `frontend/.env.example` — safe template for frontend settings.

**The archive deliberately does not contain a real `.env` file.** The uploaded original archive did include a root-level `.env` with credentials, so this cleaned release excludes it. If those credentials were ever used by a live system or committed/published, rotate the database password and JWT secret before production use. Never put passwords, JWT secrets, database URLs, or backup passphrases into a ZIP you share or into Git. The `.env.example` files contain placeholders only.

## 3. Create a database and a restricted application user

Start MySQL/MariaDB, then sign in as your database administrator:

```sh
mysql -u root -p
```

Run these statements (replace `CHOOSE_A_LONG_UNIQUE_PASSWORD` with a unique database password; do not use the placeholder literally):

```sql
CREATE DATABASE itsinda_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'itsinda_app'@'localhost'
  IDENTIFIED BY 'CHOOSE_A_LONG_UNIQUE_PASSWORD';

GRANT ALL PRIVILEGES ON itsinda_db.* TO 'itsinda_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

For a managed/remote database, follow its provider's instructions for creating a database user and allowed host; do not grant access from all hosts unless required and properly firewalled. Keep the database username and password private.

## 4. Initialize the database — choose ONE path

### A. Brand-new, empty database

Run commands from the extracted project root (the folder containing `frontend/`, `itsinda-backend/` and `database/`). The database must be empty and newly created.

```sh
mysql -u itsinda_app -p itsinda_db < database/000-base-schema.sql
mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-17-ensure-active-cycle-per-group.sql
mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-18-fund-ledger-reconciliation.sql
mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-18-priority-2-records-receipts-audit.sql
mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-18-priority-3-group-constitution.sql
mysql -u itsinda_app -p itsinda_db < itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql
```

Enter the application database password when prompted. The migrations should run in that order and **once each**. The final migration adds assessed fines and member-selected cash-count witnesses. If a migration fails, stop and inspect the error before continuing; do not blindly re-run a migration that partially changed the schema.

In PowerShell, the same `mysql ... < file.sql` commands work when the MySQL client is on PATH. If shell redirection is unavailable in your terminal, use a database GUI (such as MySQL Workbench or HeidiSQL) to execute each SQL file in the same order.

### B. Existing database already used by v10

- **Do not run `database/000-base-schema.sql`.**
- **Do not re-run v5, Priority 2, or Priority 3 migrations if they already succeeded.** Some are one-time `ALTER TABLE` migrations and will fail if run twice.
- Make a backup first. Verify that `fund_ledger_entries`, `cash_reconciliations`, `financial_receipts`, `audit_logs`, `group_constitutions`, and `constitution_votes` already exist.
- This v12 rule-enforcement update also needs the final migration's `fine_assessments` table, `transactions.fine_assessment_id` column, and `cash_reconciliations.witness_member_id` column. Check with `SHOW TABLES LIKE 'fine_assessments';`, `SHOW COLUMNS FROM transactions LIKE 'fine_assessment_id';`, and `SHOW COLUMNS FROM cash_reconciliations LIKE 'witness_member_id';`.
- If **all three** new objects are already present, do not rerun the final migration. If none are present, run `itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql` once after the v5, Priority 2 and Priority 3 migrations. If only some are present, stop and inspect the schema before proceeding: the migration isn't designed to be rerun after partial execution.
- If you're unsure which migrations have run, use a staging/backup database to verify; never guess on the live financial database.

`database/000-base-schema.sql` is not a schema upgrade tool. It only supplies the original tables required for a fresh install.

## 5. Create the backend `.env` file

Copy `itsinda-backend/.env.example` to a new file named **`itsinda-backend/.env`**. Do not rename it to `.env.txt`.

### macOS/Linux/Git Bash

```sh
cp itsinda-backend/.env.example itsinda-backend/.env
```

### Windows PowerShell

```powershell
Copy-Item itsinda-backend/.env.example itsinda-backend/.env
```

Open `itsinda-backend/.env` and replace the values with your local settings. Example structure:

```dotenv
NODE_ENV=development
PORT=5000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=itsinda_app
DB_PASSWORD=PUT_YOUR_DATABASE_PASSWORD_HERE
DB_NAME=itsinda_db
DB_CONNECTION_LIMIT=10
JWT_SECRET=PASTE_A_NEW_RANDOM_SECRET_HERE
FRONTEND_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
TRUST_PROXY_HOPS=0
```

What each variable means:

- `NODE_ENV`: use `development` locally. Use `production` only on the server after configuring every production variable.
- `PORT`: port for the API; local default is `5000`.
- `DB_HOST` / `DB_PORT`: database server address and port. Local database is usually `127.0.0.1:3306`.
- `DB_USER` / `DB_PASSWORD`: database application account and password created in Step 3.
- `DB_NAME`: database name, normally `itsinda_db`.
- `DB_CONNECTION_LIMIT`: maximum database connections held by the connection pool.
- `JWT_SECRET`: secret used to sign and verify login tokens. It must stay on the backend and should be long, random, and unique.
- `FRONTEND_ORIGINS`: exact browser origins allowed to call this backend. Origins contain protocol and hostname/port only—no route path and no trailing slash.
- `TRUST_PROXY_HOPS`: `0` locally. Set it to the number of reverse proxies you actually trust in deployment; do not guess.

If `DB_PASSWORD` contains spaces or `#`, surround the value with double quotes in `.env`. Keep the `.env` file private. If an `.env` file was already tracked by Git, ignoring it is not enough; remove it from tracking (for example, `git rm --cached --ignore-unmatch .env itsinda-backend/.env frontend/.env`) and rotate any secrets that were exposed. Removing the file from the latest commit does not erase it from Git history.

### What is `JWT_SECRET` and how do I make one?

The backend signs a JWT (JSON Web Token) at login. Later API requests carry that token, and the backend verifies its signature using `JWT_SECRET`. If someone gets this secret, they may be able to forge login tokens. It is **not** a user's password and it must never be put in frontend variables, public repositories, source code, screenshots, or shared ZIPs.

Generate a fresh value in your terminal:

```sh
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Copy the output into the backend `.env` after `JWT_SECRET=`. Do not send the generated value to anyone or paste it into this chat. Generate a separate secret for production. Changing it invalidates current sessions; users will need to log in again.

## 6. Create the frontend `.env` file

Copy `frontend/.env.example` to `frontend/.env`.

macOS/Linux/Git Bash:

```sh
cp frontend/.env.example frontend/.env
```

Windows PowerShell:

```powershell
Copy-Item frontend/.env.example frontend/.env
```

For local development, set:

```dotenv
VITE_API_BASE_URL=http://localhost:5000/api
```

`VITE_API_BASE_URL` is the base API URL used by the browser. It is okay for the API URL to be public; **never put `JWT_SECRET`, `DB_PASSWORD`, or other private credentials into a variable beginning with `VITE_`**. Vite includes `VITE_` values in the browser bundle.

## 7. Install and start the backend

Open a terminal at the project root:

```sh
cd itsinda-backend
npm ci
npm run check:syntax
npm test
npm run dev
```

The API should start on port 5000. Keep this terminal open. Check these URLs in a browser:

- `http://localhost:5000/api/health` — application process responds.
- `http://localhost:5000/api/health/ready` — application can also connect to the database.

A healthy `/api/health` does not prove that MySQL is ready; check `/api/health/ready` too.

Run backend commands from inside `itsinda-backend/`. This ensures dotenv loads `itsinda-backend/.env`. The old root-level `.env` was not appropriate for the packaged project and has been removed from this cleaned archive.

## 8. Install and start the frontend

Open a **second terminal** at the project root:

```sh
cd frontend
npm ci
npm run dev
```

Vite normally prints a local URL such as `http://localhost:5173`. Open that URL in your browser. You can also make a production frontend build with:

```sh
npm run build
```

Run linting with `npm run lint` (lint rules can surface pre-existing warnings that are separate from runtime build errors).

## 9. Register the first group and administrator

1. Open `http://localhost:5173`.
2. Choose **Register New Group**.
3. Fill in the group details and initial administrator's name, phone number and password.
4. Submit. The screen creates the group and uses the registration code it just received to register its first `ADMIN` account.
5. Return to login and sign in with that phone number and password.
6. Open **Constitution & Rules** and review/ratify the imported interim rules. Add other members from the authenticated leadership area; use unique phone numbers and tell members their credentials privately.

Keep a record of the group's registration code in a secure group administration record. Do not share admin passwords or database credentials with members.

## 10. Loan repayment by borrower

The Loan Management page now follows these steps:

1. Select an open meeting for the cash movement.
2. Under **Record Loan Repayment**, select the borrower.
3. The frontend requests that borrower's outstanding loans for the active cycle and displays a second dropdown.
4. Select the loan by its loan ID, original principal, remaining balance and due date.
5. Verify the summary of the selected loan, enter the amount received, then submit.
6. The server verifies that the loan belongs to the selected borrower, group and active cycle, rejects an amount above the remaining balance, and records repayment against that loan. The UI refreshes the outstanding-loan dropdown after success. This UI enhancement uses existing loan/member columns and requires **no new database migration**.

Only unpaid loans in the active cycle are shown because the financial rules require repayments to be recorded against an open meeting in that active cycle. If no loans appear, confirm the borrower, active cycle, loan status and outstanding balance.

## 11. Production / hosted deployment setup

Use your hosting provider's environment-variable dashboard; do not upload `.env` to a repository or static host.

**Backend production settings** must include:

- `NODE_ENV=production`
- A new, unique `JWT_SECRET` generated for production
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_CONNECTION_LIMIT`
- `FRONTEND_ORIGINS` set to your exact public frontend origin, e.g. `https://your-frontend.example` (no `/path`)
- `PORT` supplied by the hosting platform, if required
- `TRUST_PROXY_HOPS` set to the hosting provider's documented proxy count

**Frontend production build** must use a public backend URL in `frontend/.env` or the hosting build variables:

```dotenv
VITE_API_BASE_URL=https://your-api.example/api
```

Then rebuild and deploy the frontend. Do not use `localhost` in a hosted frontend: a visitor's browser would try connecting to that visitor's own computer, not the hosted backend.

Configure the backend host's database network access so only trusted clients can connect. Use HTTPS for all production web traffic. Store the database password, JWT secret and backup passphrase as secrets in the hosting provider, not as normal source files.


## 13. v12 meeting rules, fine assessments, and cash-count witnesses

Before using v12, apply `itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql` once if your database doesn't already contain all objects described in Section 4B. This migration adds `fine_assessments`, links fine payments to their assessment, and adds `witness_member_id` to cash reconciliations. Historical reconciliations remain valid but show no member witness if one was not recorded at the time.

### Fixed Social Fund rule

If the approved constitution says every present member pays a fixed amount (for example, 100 RWF per meeting), record attendance first. The application requires the member's total Social Fund payment for that meeting to equal exactly the configured amount—not less or more. Members recorded as `ABSENT` or `EXCUSED` are exempt. Meeting closure also checks all active members have their attendance recorded and every present member has paid the exact amount; an unrecorded attendance row blocks closure because the app cannot determine whether that member was present. A member who has already paid the exact amount can record their shares or a fine assessment later in the same meeting without paying the Social Fund twice.

### Minimum shares

The Constitution & Rules screen accepts a minimum of `0`. If the minimum is `1` or higher, any member contribution activity that includes a share/social-fund contribution must satisfy the rule. A fine assessment by itself is not treated as a share purchase; however, under the fixed Social Fund policy, a present member still needs their exact Social Fund contribution recorded before a fine-only submission succeeds.

### Fine rules and repayment

Choose a defined fine in Meeting Operations to assess the amount from the approved constitution. If `Allow other fines not listed above` is enabled, the `Other` choice asks for both a reason and amount. Assessing a fine records an amount the member owes, not cash that has already been received. The outstanding amount appears in the member's combined outstanding loan/fine repayment selector. When money is collected, select the borrower, choose that outstanding fine, record the actual amount received, and issue the receipt. This keeps the assessment and actual cash receipt separate.

### Cash count witness

Select a currently active group member in the witness dropdown. The witness ID is saved with the count, and the cashbook shows the member name. Older cash counts with no recorded witness remain blank and are not assigned a name retroactively.

### “Document Cash Adjustment” versus “Correct a Financial Entry (Reversal)”

- **Document Cash Adjustment** records a *new* authorized cash increase/decrease to explain a verified difference or document carried-forward/opening cash. It creates a new entry; it does not cancel any earlier transaction. `BALANCE_CORRECTION` does not change profit, while `OTHER_INCOME_OR_LOSS` affects the Loan Fund result. Use this only after investigating and documenting the real reason.
- **Correct a Financial Entry (Reversal)** is for a *specific existing eligible entry that was recorded incorrectly*. The system appends an equal-and-opposite entry linked to the original and records the reason in the audit trail. Then record the correct replacement and reconcile again. Loan disbursements and loan repayments are excluded from this generic reversal tool because reversing them safely needs loan-specific balance handling.

Do not use a cash adjustment as a shortcut for reversing an incorrect transaction. The first documents a newly recognized cash difference; the second cancels the effect of a particular erroneous entry while preserving history.

## 14. Backups and recovery

The scripts are in `itsinda-backend/scripts/backup-db.sh` and `restore-db.sh`. They require Bash and database CLI tools (`mysqldump`, `mysql`); on Windows, use WSL or Git Bash with the CLI tools installed.

For a manual local backup in macOS/Linux/Git Bash, set the variables in that terminal first (use your actual values; do not commit them):

```sh
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_USER=itsinda_app
export DB_PASSWORD='YOUR_DATABASE_PASSWORD'
export DB_NAME=itsinda_db
./itsinda-backend/scripts/backup-db.sh
```

For production, also set `NODE_ENV=production` and set `BACKUP_ENCRYPTION_PASSPHRASE` in your trusted scheduler/secret manager. The passphrase should be at least 20 characters and stored separately from backups. Do not put it in the frontend. Keep the passphrase separately from backups. The restore script requires an explicit target database and confirmation; test recovery into a staging database, not the live database.

A backup is only proven when you restore it to a separate database and check member counts, loan balances, receipts, ledger totals, and successful login.

## 13. Common problems

- **`Access denied for user`:** verify `DB_USER`, `DB_PASSWORD`, host grants and that MySQL is running.
- **`ECONNREFUSED` to port 3306:** start MySQL/MariaDB and check `DB_HOST`/`DB_PORT`.
- **Frontend reports a network error:** make sure the backend is running, the frontend `.env` ends with `/api`, and browser origin matches `FRONTEND_ORIGINS`.
- **Backend says `JWT_SECRET` is unsafe:** in production generate a fresh random value with at least 32 characters; do not use a placeholder. Restart the backend after changing it.
- **Tables or columns are missing:** confirm the base schema and each required migration are applied exactly once and in order. Never re-run a one-time migration to try to fix an unknown error.
- **A member sees “no outstanding loans”:** choose the right borrower, confirm a loan exists in the active cycle, and check that its status is `ACTIVE` and `balance_remaining` is greater than zero.

## 14. Final go-live checklist

- [ ] The project `.env` files are excluded from Git and release ZIPs.
- [ ] `JWT_SECRET` is unique, private and configured outside source code.
- [ ] Backend uses a restricted database account, not the database root user.
- [ ] Database migrations are recorded and have been applied once.
- [ ] `npm test` and `npm run check:syntax` pass in backend.
- [ ] `npm run build` passes in frontend.
- [ ] `/api/health/ready` reports ready.
- [ ] Loan issue and repayment are tested on a staging copy; repayment is attached to the correct borrower and loan.
- [ ] Receipts, passbooks, meeting closure and share-out readiness are tested.
- [ ] Encrypted backups run on schedule and a restore has been tested.
- [ ] HTTPS, CORS origins and reverse proxy settings match the actual hosting setup.
