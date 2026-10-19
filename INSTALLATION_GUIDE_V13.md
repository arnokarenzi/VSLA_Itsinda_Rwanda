# Installation checklist — Itsinda VSLA v13

## Before touching your working installation

- Make a database backup and a copy of the complete project directory.
- Keep your current `.env` files and credentials. Never commit `.env`; only `.env.example` belongs in the shared source code.
- Confirm the v12 database migration `itsinda-backend/migrations/2026-10-19-gusibuza-and-loan-day-periods.sql` is already applied. v13 adds no new SQL columns or tables beyond v12.

## Replace the code

1. Extract `Itsinda_VSLA_gusibuza_loans_attendance_v13.zip` into a new folder first, for example `~/Desktop/Projects/VSLA-v13-test`.
2. Copy your local backend `.env` and frontend `.env` into the corresponding new folders. Verify `JWT_SECRET`, database credentials, allowed frontend origin(s), and `VITE_API_BASE_URL`.
3. In `itsinda-backend`, run:

   ```bash
   npm ci
   npm test
   npm run check:syntax
   ```

4. In `frontend`, run:

   ```bash
   npm ci
   npm run build
   ```

5. Start the backend and frontend, then complete the acceptance test checklist in `V13_IMPLEMENTATION_GUIDE.md` using a staging copy of the database.
6. Only after the tests pass, back up the live database again and replace the live source/deployment with v13.

## Environment files

- Backend: `itsinda-backend/.env` (copy from `.env.example` and set local values).
- Frontend: `frontend/.env` (for local development, `VITE_API_BASE_URL=http://localhost:5000/api`). The deployed frontend must be built with the actual public backend API URL.
- Keep all secrets in backend environment variables. The JWT secret must never be in a `VITE_` variable or frontend bundle.

## Database migration rule

Do not rerun migrations that have already been applied. In particular, do not rerun `2026-10-19-gusibuza-and-loan-day-periods.sql` if the credited meeting column, Gusibuza enum value, and loan-period columns already exist. If installing a brand-new database, start with `database/000-base-schema.sql`, then apply every migration in `itsinda-backend/migrations/` in filename order, exactly once.
