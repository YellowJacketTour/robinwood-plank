import { test, expect } from "@playwright/test";
import { openCrash, connectAs } from "./helpers";

test("burning $PLANK fuel updates the Burned/Boosted counters with no console errors", async ({ page }) => {
  const errors = await openCrash(page);
  // Simulate mode always connects as the Deployer, who local-casino-setup.ts
  // never mints test $PLANK to -- Alice/Bob/Carol each hold 5000, so use the
  // manual picker here to actually exercise a successful burn.
  await connectAs(page, "Alice");

  const burnedBefore = await page.getByText("Burned").locator("xpath=following-sibling::*[1]").textContent();

  await page.getByRole("button", { name: "Burn" }).click();

  await expect
    .poll(async () => page.getByText("Burned").locator("xpath=following-sibling::*[1]").textContent(), {
      timeout: 30_000,
    })
    .not.toBe(burnedBefore);

  expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
});
