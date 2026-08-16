import { test, expect } from "@playwright/test";
import { openCrash, simulateConnect } from "./helpers";

test("entering Instant Play deposits into the Bank and persists a session key across reload", async ({ page }) => {
  const errors = await openCrash(page);
  await simulateConnect(page);

  const enterBtn = page.getByRole("button", { name: "Enter" });
  await enterBtn.click();

  // Enter chains 4 sequential on-chain confirmations (deposit, session-key
  // funding, grantSession, setPayoutRedirect) -- each waits for its own
  // block, so this genuinely takes a while on a busy local node.
  await expect(page.getByText("Deposit once, then bet with no wallet prompt.")).toBeHidden({ timeout: 90_000 });

  // Reload and reconnect via Simulate again: the previously-granted session
  // should be found valid on-chain and restored automatically, not lost.
  await page.reload();
  await expect(page.locator("#app").getByText("PLANKCRASH")).toBeVisible();
  await page.getByRole("button", { name: "▶ Simulate — no wallet needed" }).click();
  await expect(page.getByRole("button", { name: /LAUNCH · /, exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Deposit once, then bet with no wallet prompt.")).toBeHidden({ timeout: 20_000 });

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
