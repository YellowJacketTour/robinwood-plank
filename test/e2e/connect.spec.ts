import { test, expect } from "@playwright/test";
import { openCrash, simulateConnect } from "./helpers";

test("connecting via Simulate mode loads live chain state with zero console errors", async ({ page }) => {
  const errors = await openCrash(page);
  await expect(page.getByText("CONNECT A WALLET TO PLAY")).toBeVisible();

  await simulateConnect(page);

  // Real on-chain reads succeeded: round counter, pool, and player count all
  // moved off their placeholder "—" once the wallet-gated header was replaced.
  await expect(page.getByText(/^ROUND \d+$/)).toBeVisible();
  await expect(page.getByText(/^POOL [\d.]+ ETH$/)).toBeVisible();

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
