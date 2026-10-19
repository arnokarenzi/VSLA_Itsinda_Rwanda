const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_DEVELOPMENT_JWT_SECRET,
  parseAllowedOrigins,
  validateProductionConfig,
  isAllowedOrigin,
  extractBearerToken,
  FixedWindowLimiter,
} = require("../security/securityControls");
const { isInfrastructureError, sendRouteError } = require("../utils/routeErrors");

test("development CORS defaults are limited to local Vite origins", () => {
  const origins = parseAllowedOrigins({ NODE_ENV: "development" });
  assert.deepEqual(origins, [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:4173", "http://127.0.0.1:4173",
  ]);
  assert.equal(isAllowedOrigin("http://localhost:5173", origins), true);
  assert.equal(isAllowedOrigin("https://unknown.example", origins), false);
  assert.equal(isAllowedOrigin(undefined, origins), true);
});

test("production configuration rejects weak JWT secret, missing DB values, and missing CORS origins", () => {
  const problems = validateProductionConfig({ NODE_ENV: "production", JWT_SECRET: DEFAULT_DEVELOPMENT_JWT_SECRET });
  assert.ok(problems.some((problem) => problem.includes("JWT_SECRET")));
  assert.ok(problems.some((problem) => problem.includes("FRONTEND_ORIGINS")));
  assert.ok(problems.some((problem) => problem.includes("DB_HOST")));
  assert.ok(problems.some((problem) => problem.includes("DB_PASSWORD")));
});

test("production configuration rejects the example placeholder secret", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "replace-this-with-a-random-secret-at-least-32-characters",
    FRONTEND_ORIGINS: "https://itsinda.example",
    DB_HOST: "db.example", DB_USER: "itsinda", DB_NAME: "itsinda_db", DB_PASSWORD: "strong-db-password",
  });
  assert.ok(problems.some((problem) => problem.includes("non-placeholder")));
});

test("production configuration accepts explicit long secrets, database credentials and frontend origins", () => {
  const problems = validateProductionConfig({
    NODE_ENV: "production",
    JWT_SECRET: "a-unique-production-secret-with-at-least-32-characters",
    FRONTEND_ORIGINS: "https://itsinda.example,https://www.itsinda.example",
    DB_HOST: "db.example", DB_USER: "itsinda", DB_NAME: "itsinda_db", DB_PASSWORD: "strong-db-password",
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "https://itsinda.example,https://www.itsinda.example" }), [
    "https://itsinda.example", "https://www.itsinda.example",
  ]);
});

test("production CORS origin configuration rejects paths and non-HTTP origins", () => {
  assert.throws(() => parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "https://example.com/app" }), /origin only/);
  assert.throws(() => parseAllowedOrigins({ NODE_ENV: "production", FRONTEND_ORIGINS: "file:///tmp" }), /origin only/);
});

test("fixed-window limiter allows max requests then blocks until window reset", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.consume("ip-a", 100).allowed, true);
  assert.equal(limiter.consume("ip-a", 200).allowed, true);
  const blocked = limiter.consume("ip-a", 300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.consume("ip-a", 1100).allowed, true);
});

test("fixed-window limiter keeps separate client counters", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 1000, max: 1 });
  assert.equal(limiter.consume("ip-a", 1).allowed, true);
  assert.equal(limiter.consume("ip-b", 2).allowed, true);
  assert.equal(limiter.consume("ip-a", 3).allowed, false);
});

test("database errors are classified as infrastructure errors", () => {
  assert.equal(isInfrastructureError({ code: "ER_BAD_FIELD_ERROR", message: "Unknown column" }), true);
  assert.equal(isInfrastructureError({ code: "ECONNREFUSED" }), true);
  assert.equal(isInfrastructureError(new Error("A user input validation failed")), false);
});

test("database errors return a generic HTTP message without SQL details", () => {
  let responseStatus;
  let responseBody;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return this; },
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    sendRouteError(response, { code: "ER_BAD_FIELD_ERROR", message: "Unknown column secret_value in SQL" }, { fallbackStatus: 400 });
  } finally {
    console.error = originalError;
  }
  assert.equal(responseStatus, 500);
  assert.doesNotMatch(responseBody.message, /secret_value|SQL|Unknown column/);
});

test("ordinary validation messages remain actionable", () => {
  let responseStatus;
  let responseBody;
  const response = {
    status(value) { responseStatus = value; return this; },
    json(value) { responseBody = value; return this; },
  };
  sendRouteError(response, new Error("Meeting ID must be a positive integer."), { fallbackStatus: 400 });
  assert.equal(responseStatus, 400);
  assert.equal(responseBody.message, "Meeting ID must be a positive integer.");
});


test("bearer token parser accepts a single Bearer credential and rejects malformed headers", () => {
  assert.equal(extractBearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearerToken("bearer token"), "token");
  assert.equal(extractBearerToken("Basic token"), null);
  assert.equal(extractBearerToken("Bearer token extra"), null);
  assert.equal(extractBearerToken(undefined), null);
});


test("fixed-window limiter bounds memory under many distinct client keys", () => {
  const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: 10 });
  for (let index = 0; index < 10_050; index += 1) limiter.consume(`client-${index}`, 1);
  assert.ok(limiter.windows.size <= 10_000);
});
