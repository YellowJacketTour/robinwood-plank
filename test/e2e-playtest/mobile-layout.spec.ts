import { expect, test, type Browser, type Page, type FrameLocator } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * Mobile layout gates for the private playtest game surface
 * (/playtest/game -> iframe /arcade/crash.html?playtest=1&room=...).
 *
 * One real room lifecycle is driven through the real server while SIX
 * simultaneous, cookie-sharing pages watch it at different viewports:
 * 320/360/390/430 (iPhone-class mobile emulation: touch, DSF 3, mobile UA)
 * plus 1280/1920 desktop non-regression. At every phase
 * (lobby, committed, running, settled/reveal, intermission) each viewport is
 * screenshotted and the iframe document is geometry-asserted:
 *
 *   - no horizontal page overflow (scrollWidth == clientWidth);
 *   - no bounding-box overlap between the known collision pairs
 *     (fine print vs panels, stake quote vs phase tracker, tracker vs
 *     viewport edge, chips vs viewport edge);
 *   - fine print / quote lines occupy real full-width blocks, never
 *     sliver columns;
 *   - no mojibake ("Â") anywhere in the rendered text.
 */

type Json = Record<string, unknown>;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const MOBILE_WIDTHS = [320, 360, 390, 430] as const;
const DESKTOP = [
  { w: 1280, h: 800 },
  { w: 1920, h: 1080 },
] as const;

async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
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

const uuid = () => crypto.randomUUID();

async function waitForPhase(page: Page, roomId: string, wanted: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const result = await api(page, "GET", `/api/playtest/rooms/${roomId}`);
    last = String((result.json.room as Json | undefined)?.phase ?? "?");
    if (last === wanted) return;
    await page.waitForTimeout(700);
  }
  throw new Error(`room never reached phase ${wanted}; last=${last}`);
}

type Geometry = {
  scrollWidth: number;
  clientWidth: number;
  bodyScrollWidth: number;
  mojibake: boolean;
  rects: Record<string, { left: number; top: number; right: number; bottom: number; width: number; height: number } | null>;
  bottomRects: Record<string, { left: number; top: number; right: number; bottom: number; width: number; height: number } | null>;
  offenders: Array<{ selector: string; left: number; right: number; width: number }>;
};

/** Selectors whose geometry we track inside the game iframe. */
const TRACKED: Record<string, string> = {
  journey: "#privateJourney",
  payoutNote: ".payout-note",
  quote: "#stakeValueQuote",
  stakeRow: "#stakeRow",
  primaryBtn: "#actionBtn, .primary-btn",
  tableToggle: "#privateTableToggle",
  tablePanel: "#privateTablePanel:not(.mobile-open)",
  hud: "#privateHud",
  substatus: "#substatus",
};

async function measure(game: FrameLocator): Promise<Geometry> {
  return game.locator("body").evaluate((body, tracked) => {
    const doc = body.ownerDocument!;
    const de = doc.documentElement;
    const win = doc.defaultView!;
    const visible = (el: Element) => {
      const s = win.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const cv = (el as HTMLElement).checkVisibility;
      if (typeof cv === "function" && !(el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    // Occluders that are deliberately parked (faded out + click-through) do not count.
    const interactive = (el: Element) => {
      const s = win.getComputedStyle(el);
      return s.pointerEvents !== "none" && Number(s.opacity) >= 0.5;
    };
    const collect = () => {
      const out: Geometry["rects"] = {};
      for (const [name, selector] of Object.entries(tracked)) {
        const el = Array.from(doc.querySelectorAll(selector)).find((e) => visible(e) && interactive(e)) || null;
        if (!el) { out[name] = null; continue; }
        const r = el.getBoundingClientRect();
        out[name] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      return out;
    };
    const rects = collect();
    // Occlusion by fixed bottom chrome is judged at maximum scroll: content
    // scrolling beneath a bottom sheet is normal; being unreachable is not.
    const scroller = doc.scrollingElement || de;
    const prevScroll = scroller.scrollTop;
    scroller.scrollTop = scroller.scrollHeight;
    const bottomRects = collect();
    scroller.scrollTop = prevScroll;
    // Any visible element extending beyond the viewport horizontally.
    const offenders: Geometry["offenders"] = [];
    const vw = de.clientWidth;
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>("body *"))) {
      if (!visible(el)) continue;
      const s = win.getComputedStyle(el);
      if (s.position === "fixed" && s.pointerEvents === "none") continue;
      const r = el.getBoundingClientRect();
      // Ignore elements inside a horizontally scrollable ancestor.
      let a: Element | null = el.parentElement;
      let scrollable = false;
      while (a && a !== body) {
        const as = win.getComputedStyle(a);
        if (/(auto|scroll)/.test(as.overflowX)) { scrollable = true; break; }
        a = a.parentElement;
      }
      if (scrollable) continue;
      if (r.right > vw + 1.5 || r.left < -1.5) {
        offenders.push({ selector: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ")[0] || ""}`, left: r.left, right: r.right, width: r.width });
        if (offenders.length >= 12) break;
      }
    }
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      mojibake: (body.innerText || "").includes("Â"),
      rects,
      bottomRects,
      offenders,
    };
  }, TRACKED);
}

function overlapArea(a: NonNullable<Geometry["rects"][string]>, b: NonNullable<Geometry["rects"][string]>): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function assertGeometry(tag: string, width: number, g: Geometry, soft = false) {
  const ex = soft ? expect.soft : expect;
  ex(g.scrollWidth, `${tag}: horizontal page overflow (scrollWidth ${g.scrollWidth} vs clientWidth ${g.clientWidth}); offenders=${JSON.stringify(g.offenders)}`)
    .toBeLessThanOrEqual(g.clientWidth + 1);
  ex(g.mojibake, `${tag}: mojibake "Â" present in rendered text`).toBe(false);
  ex(g.offenders, `${tag}: elements past the viewport edge`).toEqual([]);
  const vw = g.clientWidth;
  // Collision pairs (only when both visible): tracker vs quote / fine print / stake chips.
  const pairs: Array<[string, string]> = [
    ["journey", "quote"],
    ["journey", "payoutNote"],
    ["journey", "stakeRow"],
    ["journey", "primaryBtn"],
    ["hud", "journey"],
  ];
  for (const [a, b] of pairs) {
    const ra = g.rects[a]; const rb = g.rects[b];
    if (!ra || !rb) continue;
    ex(overlapArea(ra, rb), `${tag}: ${a} overlaps ${b} (${JSON.stringify(ra)} vs ${JSON.stringify(rb)})`).toBeLessThanOrEqual(4);
  }
  // At maximum scroll the fixed bottom sheet must not occlude the action
  // button or the ETH/USD quote line.
  for (const name of ["primaryBtn", "quote"] as const) {
    const panel = g.bottomRects.tablePanel; const r = g.bottomRects[name];
    if (!panel || !r) continue;
    ex(overlapArea(panel, r), `${tag}: table sheet occludes ${name} at max scroll (${JSON.stringify(panel)} vs ${JSON.stringify(r)})`).toBeLessThanOrEqual(4);
  }
  // Fine print and quote must be real full-width blocks on mobile, not slivers.
  if (width <= 700) {
    for (const name of ["payoutNote", "quote"] as const) {
      const r = g.rects[name];
      if (!r) continue;
      ex(r.width, `${tag}: ${name} is a sliver column (${r.width}px wide at viewport ${vw})`).toBeGreaterThanOrEqual(vw * 0.55);
    }
    const j = g.rects.journey;
    if (j) {
      ex(j.right, `${tag}: phase tracker leaks past viewport right`).toBeLessThanOrEqual(vw + 1.5);
      ex(j.left, `${tag}: phase tracker leaks past viewport left`).toBeGreaterThanOrEqual(-1.5);
    }
    const s = g.rects.stakeRow;
    if (s) ex(s.left, `${tag}: stake chips off-canvas left`).toBeGreaterThanOrEqual(-1.5);
  }
}

test("playtest game mobile composition holds at 320/360/390/430 and desktop stays intact", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  // ── Host bootstrap + room, via a plain desktop context. ──
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  await host.goto("/playtest");
  let auth = await api(host, "POST", "/api/playtest/session", {
    action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET,
  });
  if (auth.status === 409) {
    auth = await api(host, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
  }
  expect(auth.status, JSON.stringify(auth.json)).toBe(201);
  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Mobile layout ${Date.now().toString(36)}` });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const roomId = String(created.json.id);
  // One reusable invitation shared by every viewer (invite issuance is rate-limited).
  const invite = await api(host, "POST", "/api/playtest/invites", { roomId });
  expect(invite.status, JSON.stringify(invite.json)).toBe(201);
  const inviteUrl = new URL(String(invite.json.url));

  // ── Observer pages: register each through the real invite, one per viewport. ──
  type Viewer = { label: string; width: number; page: Page; game: FrameLocator; close: () => Promise<void> };
  const viewers: Viewer[] = [];
  async function addViewer(browserRef: Browser, label: string, width: number, height: number, mobile: boolean): Promise<void> {
    const context = await browserRef.newContext(mobile ? {
      viewport: { width, height },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE_UA,
    } : { viewport: { width, height } });
    const page = await context.newPage();
    await page.goto(inviteUrl.pathname + inviteUrl.search);
    const joined = await api(page, "POST", "/api/playtest/session", {
      action: "register", displayName: `V${label} ${Date.now().toString(36)}`, pin: "4321", invite: inviteUrl.searchParams.get("invite"),
    });
    expect(joined.status, `viewer ${label}: ${JSON.stringify(joined.json)}`).toBe(201);
    await page.goto(`/playtest/game?room=${roomId}`);
    const game = page.frameLocator("iframe[title='PlankCrash private multiplayer table']");
    await expect(game.locator("#substatus")).toBeVisible({ timeout: 30_000 });
    await game.getByRole("button", { name: /ENTER THE TABLE/i }).click({ timeout: 12_000 }).catch(() => {});
    viewers.push({ label, width, page, game, close: () => context.close() });
  }
  for (const w of MOBILE_WIDTHS) { await addViewer(browser, `${w}`, w, w === 390 ? 844 : w === 430 ? 932 : 700, true); await host.waitForTimeout(2_500); }
  for (const d of DESKTOP) { await addViewer(browser, `${d.w}`, d.w, d.h, false); await host.waitForTimeout(2_500); }

  const capture = async (phase: string) => {
    for (const v of viewers) {
      await v.page.screenshot({ path: testInfo.outputPath(`${phase}-${v.label}.png`), fullPage: false });
      const g = await measure(v.game);
      assertGeometry(`${phase}@${v.label}`, v.width, g, true);
    }
  };

  // ── Phase 1: lobby. ──
  await capture("1-lobby");

  // ── Phase 2: committed (every viewer bets). ──
  for (const v of viewers) {
    const bet = await api(v.page, "POST", `/api/playtest/rooms/${roomId}/commands`, {
      action: "bet", commandId: uuid(), stake: "10000", targetBps: "15000", autoLockEnabled: true,
    });
    expect(bet.status, `bet ${v.label}: ${JSON.stringify(bet.json)}`).toBe(200);
  }
  await viewers[0].page.waitForTimeout(1_200);
  await capture("2-committed");

  // ── Phase 3: flight. ──
  const start = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "start", commandId: uuid() });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  await waitForPhase(host, roomId, "running", 90_000);
  await viewers[0].page.waitForTimeout(1_500);
  await capture("3-flight");

  // ── Phase 4: settled — crash reveal card / powerball ceremony. ──
  await waitForPhase(host, roomId, "settled", 120_000);
  await viewers[0].page.waitForTimeout(2_000);
  await capture("4-settled");

  // ── Phase 5: skip the reveal to the intermission/return state. ──
  for (const v of viewers) {
    await v.game.locator(".private-reveal-skip").click({ timeout: 5_000 }).catch(() => {});
    await v.game.locator(".private-reveal-continue").click({ timeout: 5_000 }).catch(() => {});
  }
  await viewers[0].page.waitForTimeout(2_500);
  await capture("5-intermission");

  for (const v of viewers) await v.close();
  await hostContext.close();
});
