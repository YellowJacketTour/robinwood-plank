import { test, expect } from "@playwright/test";
import { openCrash, simulateConnect } from "./helpers";

test("placing a bet flips the primary button into CASH OUT NOW with no console errors", async ({ page }) => {
  const errors = await openCrash(page);
  await simulateConnect(page);

  const primaryBtn = page.getByRole("button", { name: /^LAUNCH · /, exact: false });
  await primaryBtn.click();

  // Bet accepted: the SAME primary button relabels itself once the tx
  // confirms and the player's stake is live in the round.
  await expect(page.getByRole("button", { name: "CASH OUT NOW" })).toBeVisible({ timeout: 40_000 });

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("cashing out mid-round completes without console errors", async ({ page }) => {
  const errors = await openCrash(page);
  await simulateConnect(page);

  await page.getByRole("button", { name: /^LAUNCH · /, exact: false }).click();
  const cashOutBtn = page.getByRole("button", { name: "CASH OUT NOW" });
  await expect(cashOutBtn).toBeVisible({ timeout: 40_000 });

  await page.waitForTimeout(1000); // let the multiplier tick a bit above 1.00x first
  await cashOutBtn.click();

  // Successful cash-out swaps the primary control back to a fresh launch
  // button for the (already-locked) round, or hands off to the round's own
  // resolution -- either way, no error should surface client-side.
  await page.waitForTimeout(3000);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
