## Latest update: v13

This release adds the Gusibuza late-share workflow, day-based loan interest on outstanding principal, strict attendance statuses, automatic absence fines at meeting close, and per-member contribution summaries. See [`V13_IMPLEMENTATION_GUIDE.md`](V13_IMPLEMENTATION_GUIDE.md) and [`INSTALLATION_GUIDE_V13.md`](INSTALLATION_GUIDE_V13.md).

# Itsinda VSLA

Itsinda is a React/Vite frontend and an Express/MySQL backend for Village Savings and Loan Associations.

## Start here

Read [`SETUP_GUIDE.md`](SETUP_GUIDE.md) before installing or deploying the project. It explains database bootstrap and migration order, backend/frontend `.env` files, `JWT_SECRET`, local development, testing, backups, production deployment and how the borrower-selected loan repayment workflow works.

## Project layout

- `frontend/` — React + Vite application.
- `itsinda-backend/` — Express API and MySQL access.
- `database/000-base-schema.sql` — base tables for a new, empty database only.
- `itsinda-backend/migrations/` — one-time upgrades for an existing base schema.

Never commit or share `.env` files. Copy the provided `.env.example` templates and add your own local secrets.


## v12 release notes

- Fixed Social Fund contributions now require the exact constitution amount for every present member; absent/excused members are exempt. Meeting closure checks complete attendance and contributions under this rule.
- Constitution minimum shares per meeting can be configured as 0. A positive minimum is enforced when recording contribution activity.
- Fine rules use a dropdown; approved fine amounts are read from the constitution. `Other` requests a reason and amount only when allowed. Fine assessment creates an outstanding obligation, not a cash receipt; collect it through the borrower/loan/fine repayment workflow.
- Cash reconciliation requires a selected active member as witness.
- The new SQL migration is `itsinda-backend/migrations/2026-10-19-fine-assessments-and-cash-witness.sql`; see `SETUP_GUIDE.md` Section 4 for fresh/existing databases.
