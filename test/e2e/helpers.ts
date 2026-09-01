import { Page, expect } from "@playwright/test";

/** Fresh page on crash.html with console errors captured for the caller to assert on. */
export async function openCrash(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto("/arcade/crash.html");
  // "PLANKCRASH" appears twice (a boot splash, then the live app header) --
  // scope to the app header so this resolves once it's actually loaded.
  await expect(page.locator("#app").getByText("PLANKCRASH")).toBeVisible();
  return errors;
}

/** Enter Simulate mode -- the no-wallet local-test-account path every other spec builds on. */
export async function simulateConnect(page: Page) {
  await page.getByRole("button", { name: "▶ Simulate — no wallet needed" }).click();
  // Connection is phase-independent. A shared live chain may already be in
  // flight or settlement, so requiring a LAUNCH label made an otherwise
  // healthy connection test wait for the next round and intermittently fail.
  await expect(page.getByText(/^ROUND \d+$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^POOL [\d.]+ ETH$/)).toBeVisible({ timeout: 30_000 });
}

/**
 * Connect via the manual picker as one of the funded local test accounts
 * (Alice/Bob/Carol -- NOT the Deployer, who Simulate mode always uses and
 * who local-casino-setup.ts never mints test $PLANK to). Needed for any
 * flow that requires a real $PLANK balance, like fuel-burn.
 */
export async function connectAs(page: Page, name: "Alice" | "Bob" | "Carol") {
  const res = await page.request.get("/arcade/deploy-addresses.local.json");
  const { crash } = await res.json();
  await page.getByRole("button", { name: "Open connection settings" }).click();
  await page.getByRole("textbox", { name: "0x..." }).fill(crash);
  await page.getByRole("button", { name: new RegExp("^" + name + " 0x") }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/^ROUND \d+$/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^POOL [\d.]+ ETH$/)).toBeVisible({ timeout: 30_000 });
}
