import { test, expect } from "@playwright/test";
import { openCrash, simulateConnect } from "./helpers";

test("sound toggle button reflects pressed state and persists across reload", async ({ page }) => {
  const errors = await openCrash(page);
  const toggle = page.getByRole("button", { name: "Toggle sound" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(page.getByRole("button", { name: "Toggle sound" })).toHaveAttribute("aria-pressed", "false");

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("role=button controls are keyboard-activatable via Enter/Space", async ({ page }) => {
  const errors = await openCrash(page);
  // The popover is always in the DOM (opacity/transform transition, not
  // display:none) -- open/closed is asserted via its "show" class.
  const popover = page.locator("#pbPopover");
  const pbButton = page.getByRole("button", { name: "Open Powerboard lottery details" });

  await pbButton.focus();
  await page.keyboard.press("Enter");
  await expect(popover).toHaveClass(/show/);

  await page.getByRole("button", { name: "Close Powerboard details" }).click();
  await expect(popover).not.toHaveClass(/show/);

  await pbButton.focus();
  await page.keyboard.press(" ");
  await expect(popover).toHaveClass(/show/);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});

test("page respects prefers-reduced-motion without erroring", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = await openCrash(page);
  await simulateConnect(page);
  await expect(page.locator("#multGraph")).toBeVisible();
  await page.waitForTimeout(2_000);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  await context.close();
});
