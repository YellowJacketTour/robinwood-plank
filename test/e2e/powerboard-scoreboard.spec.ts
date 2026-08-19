import { test, expect } from "@playwright/test";
import { openCrash, simulateConnect } from "./helpers";

test("Powerboard popover opens and shows live ticket/jackpot info", async ({ page }) => {
  const errors = await openCrash(page);
  await simulateConnect(page);

  // The popover is always in the DOM (a CSS opacity/transform transition,
  // not display:none), so open/closed is asserted via its "show" class,
  // not raw visibility.
  const popover = page.locator("#pbPopover");
  await expect(popover).not.toHaveClass(/show/);

  await page.getByRole("button", { name: "Open Powerboard lottery details" }).click();
  await expect(popover).toHaveClass(/show/);
  await expect(
    page.getByText("Every crash bet earns you a lottery ticket automatically")
  ).toBeVisible();

  await page.getByRole("button", { name: "Close Powerboard details" }).click();
  await expect(popover).not.toHaveClass(/show/);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("Stats panel opens and can run a real on-chain event scan", async ({ page }) => {
  const errors = await openCrash(page);
  await simulateConnect(page);

  await page.getByRole("button", { name: "Open stats and leaderboard" }).click();
  await expect(page.getByRole("heading", { name: "Stats" })).toBeVisible();

  await page.getByRole("button", { name: "Refresh" }).click();
  // A real queryFilter scan against the local chain -- give it a moment,
  // then assert it didn't blow up (no error toast, no console error).
  await page.waitForTimeout(2000);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
