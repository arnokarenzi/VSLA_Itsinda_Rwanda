# Fix for backend test discovery (v11.1)

The backend test script now runs only first-level files in `itsinda-backend/test/` whose names end in `.test.js`. This prevents Node's automatic test discovery from executing unrelated frontend configuration/source files in a nested `test/VSLA/frontend/` folder.

## Apply this to an existing checkout

1. Replace `itsinda-backend/package.json` with the version from v11.1 (or change its `scripts.test` value to `node scripts/run-tests.js`).
2. Copy `itsinda-backend/scripts/run-tests.js` into your checkout.
3. Run from `itsinda-backend/`:

   ```bash
   npm test
   ```

This runner executes the backend's actual `*.test.js` files directly under `test/` and does not recursively discover nested frontend files. It is safe to use on Linux and Windows.

## Optional cleanup

The test runner intentionally ignores nested folders. You can inspect stale content with:

```bash
find test -maxdepth 3 -type f | sort | head -100
```

Do not delete files blindly if you've added your own fixtures. A clean extraction of the ZIP into a new folder is the simplest way to avoid leftover files from previous versions.

## Separate npm audit warning

`npm ci` reported three high-severity vulnerabilities. This is separate from the test-discovery problem. Review the report using `npm audit` and `npm audit --omit=dev`; do not run `npm audit fix --force` blindly, since it may introduce breaking dependency upgrades.
