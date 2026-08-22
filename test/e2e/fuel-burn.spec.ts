import { test, expect } from "@playwright/test";
import { openCrash, connectAs } from "./helpers";

test("burning $PLANK fuel updates the Burned/Boosted counters with no console errors", async ({ page }) => {
  const errors = await openCrash(page);
  // Simulate mode always connects as the Deployer, who local-casino-setup.ts
  // never mints test $PLANK to -- Alice/Bob/Carol each hold 5000, so use the
  // manual picker here to actually exercise a successful burn.
  await connectAs(page, "Alice");

  const burnedBefore = await page.getByText("Burned").locator("xpath=following-sibling::*[1]").textContent();

  // The fuel panel's innerHTML is fully rebuilt on every ~600ms poll tick
  // (see refreshFuelUI in crash.html) rather than diffed, so the #flBurn
  // button can detach mid-click under any real contention -- force the
  // click and retry until it actually registers (fuelBusy guards the app
  // side against a double-submit if an earlier click DID land first).
  await expect
    .poll(
      async () => {
        await page.locator("#flBurn").click({ force: true, timeout: 2000 }).catch(() => {});
        return page.getByText("Burned").locator("xpath=following-sibling::*[1]").textContent();
      },
      { timeout: 90_000 }
    )
    .not.toBe(burnedBefore);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
