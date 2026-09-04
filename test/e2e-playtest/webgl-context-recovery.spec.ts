import { expect, test, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * WEBGL CONTEXT RECOVERY — the boot curtain must never strand a player.
 *
 * Phones reclaim GPU memory from a backgrounded tab. iOS Safari in particular
 * often discards the WebGL context PERMANENTLY: `webglcontextlost` fires and
 * `webglcontextrestored` never does. The handler showed
 * "RECONNECTING THE FLIGHT DECK · YOUR TABLE AND ROUND ARE SAFE ON THE SERVER"
 * and then waited for a restore event that would never arrive, leaving the
 * table behind an opaque curtain until the player reloaded by hand.
 *
 * This drives the real failure: dispatch webglcontextlost, never restore, and
 * require the page to recover on its own.
 */

const GAME_FRAME = "iframe[title='PlankCrash private multiplayer table']";

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, json };
  }, { method, path, body });
}

test("a permanently lost WebGL context recovers instead of stranding the player", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  await page.goto("/playtest");
  let boot = await api(page, "POST", "/api/playtest/session", {
    action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET,
  });
  if (boot.status === 409) boot = await api(page, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
  expect(boot.status, JSON.stringify(boot.json).slice(0, 200)).toBeLessThan(400);

  const created = await api(page, "POST", "/api/playtest/rooms", { action: "create", name: `GL ${Date.now().toString(36)}` });
  expect(created.status, JSON.stringify(created.json).slice(0, 200)).toBeLessThan(400);
  const roomId = String(created.json.id);

  await page.goto(`/playtest/game?room=${roomId}`);
  const game = page.frameLocator(GAME_FRAME);
  await expect(game.locator("#primaryBtn")).toBeVisible({ timeout: 60_000 });

  const frame = page.frames().find((f) => f.url().includes("/arcade/crash.html"));
  expect(frame, "game frame not found").toBeTruthy();

  // Lose the context and NEVER restore it — the real mobile failure.
  const dispatched = await frame!.evaluate(() => {
    // The renderer's canvas is #fx specifically, not merely the first canvas.
    const canvas = document.getElementById("fx");
    if (!canvas) return false;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    return true;
  });
  expect(dispatched, "#fx canvas not found — the loss was never delivered").toBe(true);

  // The curtain is expected immediately; that part was always correct.
  await expect
    .poll(async () => frame!.evaluate(() => document.getElementById("boot")?.classList.contains("hide") === false), { timeout: 5_000 })
    .toBe(true);

  // The player must NOT still be behind it. Recovery is either a reload (the
  // frame navigates and the deck comes back) or the degrade path lifting the
  // curtain. Both end with a usable table; waiting forever is the bug.
  // Poll the LIVE frame each time: recovery navigates it, so a locator held
  // across the reload reads a detached document.
  await expect
    .poll(async () => {
      const live = page.frames().find((x) => x.url().includes("/arcade/crash.html"));
      if (!live) return "no-frame";
      try {
        return await live.evaluate(() => (document.getElementById("boot")?.classList.contains("hide") ? "clear" : "curtained"));
      } catch { return "navigating"; }
    }, { timeout: 45_000 })
    .toBe("clear");
  await expect(page.frameLocator(GAME_FRAME).locator("#primaryBtn")).toBeVisible({ timeout: 45_000 });

  await context.close();
});
