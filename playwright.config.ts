import { defineConfig, devices } from "@playwright/test";

/**
 * Regression suite for the arcade frontend (public/arcade/*.html) against a
 * real local Hardhat chain -- no mocks. globalSetup spins up the node and
 * deploys the casino contracts once for the whole run; each spec drives the
 * page exactly the way a player would (Simulate mode, real tx confirmations).
 */
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false, // specs share one chain; concurrent runs would race round state
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  globalSetup: "./test/e2e/global-setup.ts",
  globalTeardown: "./test/e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:8789",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx serve public -l 8789",
    url: "http://127.0.0.1:8789/arcade/crash.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
