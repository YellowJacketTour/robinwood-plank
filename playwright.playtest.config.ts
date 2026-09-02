import { defineConfig, devices } from "@playwright/test";

/**
 * Full fake-mainnet table-lifecycle proof for the private playtest
 * (app/playtest/game serving public/arcade/crash.html) against a REAL local
 * Next.js server and a REAL PostgreSQL database — no mocks anywhere.
 *
 * Prerequisites (one-time, documented in test/e2e-playtest/table-lifecycle.spec.ts):
 *   - a reachable PostgreSQL with the playtest migrations applied
 *     (scripts/migrate-postgres.mjs), pointed to by PGHOST/PGPORT/PGDATABASE/
 *     PGUSER/PGPASSWORD below (defaults target the local docker instance);
 *   - nothing else: the spec bootstraps the host account itself through the
 *     deployment-credential path.
 *
 * Run: npx playwright test -c playwright.playtest.config.ts
 */
const PORT = Number(process.env.PLAYTEST_E2E_PORT || 3111);
const BOOTSTRAP_SECRET = process.env.PLAYTEST_E2E_BOOTSTRAP_SECRET
  || "fixtest-bootstrap-secret-2026-09-02-plankcrash";

export { BOOTSTRAP_SECRET };

export default defineConfig({
  testDir: "./test/e2e-playtest",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 480_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/playtest/session`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      PGHOST: process.env.PGHOST || "127.0.0.1",
      PGPORT: process.env.PGPORT || "54329",
      PGDATABASE: process.env.PGDATABASE || "plank_fixtest",
      PGUSER: process.env.PGUSER || "plankapp",
      PGPASSWORD: process.env.PGPASSWORD || "1IX9CsE96avsSEX9QVNLkbQWS6-KMwRO",
      PLANK_PLAYTEST_ENABLED: "true",
      PLANK_PLAYTEST_ORIGIN: `http://localhost:${PORT}`,
      PLANK_PLAYTEST_RP_ID: "localhost",
      PLANK_PLAYTEST_BOOTSTRAP_HASH:
        process.env.PLAYTEST_E2E_BOOTSTRAP_HASH
        || "4c815e98936cee6167d7fd95c95e8374c155bd03d094570e80b2a232d9fb7d82",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
