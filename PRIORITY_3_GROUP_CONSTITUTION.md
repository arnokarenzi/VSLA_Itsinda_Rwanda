# Itsinda VSLA — Priority 3: Group Constitution & Rules (v8)

## What this update adds

- A **Constitution & Rules** page visible to all signed-in members.
- Versioned current rules and proposals; existing settings are imported on first page visit as **interim legacy rules**, not falsely labelled member-approved.
- Leadership can propose updates, with a reason. A proposal does not change operating rules immediately.
- Every active user in the group can vote once per proposal. A proposal is approved or rejected when it receives an absolute majority of all currently active users (`floor(active users / 2) + 1`). If all active users vote and neither side has a majority, it is marked deadlocked.
- Approved constitution settings are written into `groups.settings` in the same database transaction and used by existing financial services.
- Server-side enforcement of share minimum/maximum per member per meeting, fixed/disabled Social Fund contributions, named fine amounts and allowed fine types, borrowing multiple, interest calculation method and maximum loan duration.
- Audit events for proposals and votes.
- Registration hardening: only the first ADMIN can be created without login, and they must supply the new group's registration code. Existing groups require an authenticated active leadership user to add members; only ADMIN/CHAIRPERSON may assign leadership roles. This prevents someone who only knows a group ID from registering fake voting users.

## Constitution fields

- Share price, minimum shares and optional maximum shares per member per meeting.
- Maximum loan principal as a multiple of a member's recorded savings.
- Interest/service-charge rate and method: `FLAT_PER_MONTH` or `FLAT_ONCE`.
- Maximum loan duration in months.
- Social Fund mode: no regular contributions, flexible amount, or a fixed per-member/per-meeting amount.
- Fine schedule and whether unlisted fines are permitted.
- Meeting cadence, custom interval, and intended savings-cycle duration.
- Written member withdrawal and loan-default policies.

## What is enforced automatically

The backend enforces configured numeric transaction rules rather than trusting form fields. Approved share prices and loan settings apply to future transaction submissions and new loans. Known fine labels must use the configured amount. Social Fund contributions can be disabled or capped to the fixed per-member/per-meeting total. Previously issued loans retain their original balance and amount due.

Meeting cadence, intended cycle length, and the written withdrawal/default procedures are stored and displayed for the group. This release does not automatically deactivate a withdrawing member, restructure a defaulted loan, or declare default; those actions require dedicated workflows and the group's decision-making policy. Share minimums are checked when a member purchases shares, not when they record a fine or Social Fund contribution without buying shares.

## Voting rule

Approval requires more than half of all currently active users in the group, not merely a majority of votes submitted so far. Each active user gets one vote per proposal and cannot change it. When one side reaches the threshold, the proposal is resolved immediately. If every active user votes and the threshold is not reached (for example a tie in a four-person group), the proposal is marked `DEADLOCKED` and leadership can submit a revised proposal.

## Install steps

1. Back up the source tree and `itsinda_db`.
2. Run `backend/migrations/2026-10-18-priority-3-group-constitution.sql` once, after the existing v5 fund-ledger and v7 Priority 2 migrations.
3. Replace the project files with the v8 source, keeping your `.env` and database credentials.
4. Install dependencies if needed, then run backend tests with `cd backend && npm test` and a frontend production build with `cd frontend && npm ci && npm run build`.
5. Restart the application. Sign in and open **Constitution & Rules**. The first visit imports the group's existing settings as interim version 1 (unless a current version already exists).
6. Review those settings with members. Leadership should submit a proposal explaining the group's decision. Each member signs in, reviews all proposed terms and votes. Changes become active only after the majority threshold is reached.

The Priority 3 migration is one-time. Do not rerun it after success. No existing loan or financial transaction is changed by the migration or by ratifying a constitution.

## Validation performed

- `node --check` passed for all backend JavaScript files.
- 16 backend unit tests passed, including constitution validation, voting thresholds, interest methods, share limits, fixed/disabled Social Fund behavior, and fine rules.
- 14 frontend JS/JSX files parsed without syntax errors using the installed TypeScript JSX transpiler.
- A complete `vite build` and live MariaDB integration test could not be run in this environment because frontend dependency installation timed out and there is no configured test database. Run both before deploying to production.
