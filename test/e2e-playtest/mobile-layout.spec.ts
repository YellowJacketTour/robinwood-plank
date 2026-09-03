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
  journeyFit: { scrollWidth: number; clientWidth: number } | null;
};

/** Selectors whose geometry we track inside the game iframe. */
const TRACKED: Record<string, string> = {
  journey: "#privateJourney",
  payoutNote: ".payout-note",
  quote: "#stakeValueQuote",
  stakeRow: "#stakeRow",
  autoRow: "#autoRow",
  primaryBtn: "#actionBtn, .primary-btn",
  tableToggle: "#privateTableToggle",
  tablePanel: "#privateTablePanel:not(.mobile-open)",
  hud: "#privateHud",
  substatus: "#substatus",
  topbar: ".topbar",
  stage: ".stage",
  countdown: "#privateIntermissionCountdown",
  multReadout: "#multReadout",
};

/** Elements that are deliberately pointer-events:none / decorative but whose
 *  GEOMETRY still matters (stage stack collisions, clipped readouts). */
const GEOMETRY_ONLY = new Set(["substatus", "topbar", "stage", "countdown", "multReadout"]);

async function measure(game: FrameLocator): Promise<Geometry> {
  return game.locator("body").evaluate((body, { tracked, geometryOnly }) => {
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
        const el = Array.from(doc.querySelectorAll(selector)).find((e) => visible(e) && (geometryOnly.includes(name) || interactive(e))) || null;
        if (!el) { out[name] = null; continue; }
        const r = el.getBoundingClientRect();
        out[name] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      }
      return out;
    };
    // The first-content-row gate is judged at the very top of the page: the
    // title row must be fully visible before any scrolling.
    const scroller = doc.scrollingElement || de;
    const prevScroll = scroller.scrollTop;
    scroller.scrollTop = 0;
    const rects = collect();
    // Occlusion by fixed bottom chrome is judged at maximum scroll: content
    // scrolling beneath a bottom sheet is normal; being unreachable is not.
    scroller.scrollTop = scroller.scrollHeight;
    const bottomRects = collect();
    scroller.scrollTop = prevScroll;
    const journeyEl = doc.querySelector("#privateJourney");
    const journeyFit = journeyEl ? { scrollWidth: journeyEl.scrollWidth, clientWidth: journeyEl.clientWidth } : null;
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
      mojibake: ((body as HTMLElement).innerText || "").includes("Â"),
      rects,
      bottomRects,
      offenders,
      journeyFit,
    };
  }, { tracked: TRACKED, geometryOnly: Array.from(GEOMETRY_ONLY) });
}

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type RevealGeometry = {
  viewportHeight: number;
  drawActive: string | null;
  strayBall: boolean;
  titleFontPx: number;
  noteTag: string | null;
  noteOpen: boolean | null;
  tiles: number;
  tileLabels: string[];
  atMaxScroll: Record<"next" | "canvas" | "world" | "note", Rect | null>;
  atTop: Record<"next" | "canvas" | "world" | "note", Rect | null>;
};

/** Settled/reveal-phase geometry of the private result sheet, measured at
 *  scrollTop 0 and at the sheet's maximum scroll (the sheet is its own
 *  scroller; the docked action block is fixed to its bottom edge). */
async function measureReveal(game: FrameLocator): Promise<RevealGeometry | null> {
  return game.locator("body").evaluate((body) => {
    const doc = body.ownerDocument!; const win = doc.defaultView!;
    const card = doc.querySelector<HTMLElement>(".result-card.private-result.show");
    if (!card) return null;
    const visible = (el: Element | null) => {
      if (!el) return false;
      const s = win.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const rect = (sel: string) => {
      const el = card.querySelector(sel);
      if (!el || !visible(el)) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const collect = () => ({ next: rect(".private-result-next"), canvas: rect(".private-powerball-canvas"), world: rect(".private-result-world"), note: rect(".private-result-note") });
    const prev = card.scrollTop;
    card.scrollTop = 0; const atTop = collect();
    card.scrollTop = card.scrollHeight; const atMaxScroll = collect();
    card.scrollTop = prev;
    const powerball = card.querySelector(".private-powerball");
    const note = card.querySelector<HTMLElement>(".private-result-note");
    const title = card.querySelector(".result-mult");
    return {
      viewportHeight: win.innerHeight,
      drawActive: powerball?.getAttribute("data-draw-active") ?? null,
      strayBall: Array.from(card.querySelectorAll(".private-powerball-drum b, .private-lottery-fallback b")).some(visible),
      titleFontPx: title ? parseFloat(win.getComputedStyle(title).fontSize) : 0,
      noteTag: note ? note.tagName : null,
      noteOpen: note && note.tagName === "DETAILS" ? (note as HTMLDetailsElement).open : null,
      tiles: card.querySelectorAll(".private-result-world > span").length,
      tileLabels: Array.from(card.querySelectorAll(".private-result-world > span > small")).map((el) => (el.textContent || "").trim()),
      atMaxScroll, atTop,
    };
  });
}

function assertReveal(tag: string, width: number, g: RevealGeometry | null) {
  const ex = expect.soft;
  ex(g, `${tag}: private result sheet not shown`).not.toBeNull();
  if (!g) return;
  // Honest tiles: never a "PRIZE 0" / "RESET RESERVE 0" beside a funded total.
  ex(g.tileLabels, `${tag}: PROTECTED VAULT tile missing`).toContain("PROTECTED VAULT");
  ex(g.tileLabels, `${tag}: COMMUNITY FUNDED tile missing`).toContain("COMMUNITY FUNDED");
  ex(g.tileLabels.includes("PRIZE FUNDING") !== g.tileLabels.includes("LOTTERY PRIZE") || g.tileLabels.includes("NEXT PRIZE BASE"),
    `${tag}: exactly one of PRIZE FUNDING / LOTTERY PRIZE must be shown (${g.tileLabels.join(", ")})`).toBe(true);
  // No stray placeholder ball while the prize is still funding.
  if (g.drawActive === "false") ex(g.strayBall, `${tag}: placeholder ball rendered while funding`).toBe(false);
  if (width > 700) return;
  // Phone sheet: machine canvas capped, title clamped, explanation collapsed.
  const canvas = g.atTop.canvas ?? g.atMaxScroll.canvas;
  if (canvas) ex(canvas.height, `${tag}: machine canvas ${canvas.height}px > 34% of ${g.viewportHeight}px viewport`).toBeLessThanOrEqual(g.viewportHeight * 0.34 + 1);
  ex(g.titleFontPx, `${tag}: headline font ${g.titleFontPx}px not clamped`).toBeLessThanOrEqual(32.5);
  if (g.noteTag === "DETAILS") ex(g.noteOpen, `${tag}: "How this settled" must start collapsed`).toBe(false);
  // Docked action block never covers content at max scroll, and is docked.
  const next = g.atMaxScroll.next;
  ex(next, `${tag}: docked action block not visible`).not.toBeNull();
  if (next) {
    ex(next.bottom, `${tag}: action block not docked at the sheet bottom (${JSON.stringify(next)})`).toBeLessThanOrEqual(g.viewportHeight + 1);
    for (const name of ["canvas", "world", "note"] as const) {
      const r = g.atMaxScroll[name];
      if (!r) continue;
      ex(overlapArea(next, r), `${tag}: docked buttons overlap ${name} at max scroll (${JSON.stringify(next)} vs ${JSON.stringify(r)})`).toBeLessThanOrEqual(1);
    }
  }
}

function overlapArea(a: NonNullable<Geometry["rects"][string]>, b: NonNullable<Geometry["rects"][string]>): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function assertGeometry(tag: string, width: number, g: Geometry, soft = false, phase = "") {
  const ex = soft ? expect.soft : expect;
  // R1 gate: the first content row (PLANKCRASH · ROUND title bar) must be
  // fully visible at the very top of the page — never clipped above y=0.
  const tb = g.rects.topbar;
  if (tb) ex(tb.top, `${tag}: topbar clipped at page top (top=${tb.top})`).toBeGreaterThanOrEqual(-0.5);
  // R2 gate: at phone widths every phase-tracker step fits without needing
  // an inner scroll (compressed labels), so RETURN can never be cut off.
  if (width <= 700 && g.journeyFit) {
    ex(g.journeyFit.scrollWidth, `${tag}: phase tracker overflows its container (${JSON.stringify(g.journeyFit)})`)
      .toBeLessThanOrEqual(g.journeyFit.clientWidth + 1);
  }
  // R3 gates: deliberate intermission stage stack on phones.
  if (phase.includes("intermission") && width <= 700) {
    const stage = g.rects.stage; const card = g.rects.countdown; const caption = g.rects.substatus;
    ex(card, `${tag}: intermission countdown card missing`).not.toBeNull();
    ex(g.rects.multReadout, `${tag}: crashed multiplier readout still rendered mid-stage during intermission`).toBeNull();
    if (stage && card && caption) {
      ex(overlapArea(card, caption), `${tag}: countdown card overlaps auto-launch caption`).toBeLessThanOrEqual(1);
      ex(caption.top, `${tag}: caption not BELOW the countdown card`).toBeGreaterThanOrEqual(card.bottom - 1);
      for (const [name, r] of [["countdown card", card], ["caption", caption]] as const) {
        ex(r.top, `${tag}: ${name} clipped above stage`).toBeGreaterThanOrEqual(stage.top - 1);
        ex(r.left, `${tag}: ${name} clipped left of stage`).toBeGreaterThanOrEqual(stage.left - 1);
        ex(r.right, `${tag}: ${name} clipped right of stage`).toBeLessThanOrEqual(stage.right + 1);
        // Rocket rest/fall zone is the lower half of the stage: the card and
        // caption must stay in the top half so text never straddles the sprite.
        ex(r.bottom, `${tag}: ${name} intrudes into the rocket's half of the stage (${JSON.stringify(r)} vs stage ${JSON.stringify(stage)})`)
          .toBeLessThanOrEqual(stage.top + stage.height * 0.58);
      }
    }
  }
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
  // button, the REPEAT/cash-out row, the stake chips or the ETH/USD quote.
  for (const name of ["primaryBtn", "quote", "stakeRow", "autoRow"] as const) {
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
      assertGeometry(`${phase}@${v.label}`, v.width, g, true, phase);
      if (v.label === "390") {
        // Safari with its chrome expanded: same 390pt width, much shorter
        // visual viewport. Same page and session, temporarily resized -- an
        // extra browser context here starves the dev server's long-poll
        // budget and stalls the authoritative auto-tick.
        await v.page.setViewportSize({ width: 390, height: 660 });
        await v.page.waitForTimeout(400);
        await v.page.screenshot({ path: testInfo.outputPath(`${phase}-390short.png`), fullPage: false });
        const gs = await measure(v.game);
        assertGeometry(`${phase}@390short`, v.width, gs, true, phase);
        await v.page.setViewportSize({ width: 390, height: 844 });
        await v.page.waitForTimeout(250);
      }
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

  // ── R7 UI truth: AUTO-LOCK is a committed, amendable-only-pre-launch choice. ──
  // Every bet above committed autoLockEnabled true; the chip must show it armed,
  // and disarming BEFORE launch must be a real server amendment.
  const disarmer = viewers.find((v) => v.label === "320")!;
  await expect.soft(disarmer.game.locator("#privateAutoLockChip")).toHaveText(/AUTO-LOCK ✓/, { timeout: 10_000 });
  await disarmer.game.locator("#privateAutoLockChip").click();
  await disarmer.page.waitForTimeout(1_500);
  const disarmedState = await api(disarmer.page, "GET", `/api/playtest/rooms/${roomId}`);
  const disarmedSeat = (disarmedState.json.seats as Array<Json> | undefined)?.find(
    (seat) => seat.userId === (disarmedState.json.me as Json | undefined)?.id);
  expect.soft(disarmedSeat?.autoLockEnabled, "pre-launch disarm must clear the committed auto target server-side").toBe(false);
  await expect.soft(disarmer.game.locator("#privateAutoLockChip")).toHaveText(/AUTO-LOCK OFF/);

  // ── Phase 3: flight. ──
  const start = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "start", commandId: uuid() });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  await waitForPhase(host, roomId, "running", 90_000);
  await viewers[0].page.waitForTimeout(1_500);
  await capture("3-flight");

  // R7 fail-closed: after launch the auto-lock commitment is immutable. A
  // disarm attempt mid-flight must be refused and the armed truth kept.
  const flier = viewers.find((v) => v.label === "360")!;
  const midFlight = await api(flier.page, "GET", `/api/playtest/rooms/${roomId}`);
  if (String((midFlight.json.room as Json | undefined)?.phase) === "running") {
    await flier.game.locator("#privateAutoLockChip").click().catch(() => {});
    await flier.page.waitForTimeout(800);
    const after = await api(flier.page, "GET", `/api/playtest/rooms/${roomId}`);
    const seatAfter = (after.json.seats as Array<Json> | undefined)?.find(
      (seat) => seat.userId === (after.json.me as Json | undefined)?.id);
    if (String((after.json.room as Json | undefined)?.phase) === "running") {
      expect.soft(seatAfter?.autoLockEnabled, "mid-flight disarm must be refused; server stays ARMED").toBe(true);
      await expect.soft(flier.game.locator("#privateAutoLockChip")).toHaveText(/AUTO-LOCK ✓/);
    }
  }

  // ── R6: post-crash return descent -- sampled from the moment of settlement. ──
  const descentViewer = viewers.find((v) => v.label === "390")!;
  const readFlight = () => descentViewer.game.locator("body").evaluate(
    () => (window as unknown as { __plankFlight: { p: number; t: number } }).__plankFlight);

  // ── Phase 4: settled — crash reveal card / powerball ceremony. ──
  await waitForPhase(host, roomId, "settled", 120_000);
  // ── Phase 4b gate: reveal sheet at its final ("world") stage — docked
  // actions, honest tiles, capped machine, no placeholder ball. Runs on the
  // phone viewers IMMEDIATELY at settlement (concurrently with the R6 descent
  // sampling below): the sheet auto-acknowledges itself late in the 30s
  // intermission, so the slower full-page capture runs after these gates. ──
  const revealGate = async (v: Viewer) => {
    await v.game.locator(".private-reveal-skip").click({ timeout: 3_000 }).catch(() => {});
    await v.page.waitForTimeout(500);
    await v.page.screenshot({ path: testInfo.outputPath(`4b-reveal-${v.label}.png`), fullPage: false });
    const reveal = await measureReveal(v.game);
    if (v.width <= 700 || reveal) assertReveal(`4b-reveal@${v.label}`, v.width, reveal);
    if (v.label === "390") {
      await v.page.setViewportSize({ width: 390, height: 660 });
      await v.page.waitForTimeout(400);
      await v.page.screenshot({ path: testInfo.outputPath("4b-reveal-390short.png"), fullPage: false });
      assertReveal("4b-reveal@390short", v.width, await measureReveal(v.game));
      await v.page.setViewportSize({ width: 390, height: 844 });
      await v.page.waitForTimeout(250);
    }
  };
  // R6 altitude law: from settlement the craft is LOWERED to the pad --
  // monotone non-increasing samples until they equal the pad anchor
  // (flightProgress 0 == ROCKET_REST_Y), then constant. Mid-descent
  // screenshot taken while the samples are still moving.
  const altitudes: number[] = [];
  const sampleDescent = async () => {
    for (let i = 0; i < 18; i++) {
      const sample = await readFlight();
      altitudes.push(sample.p);
      if (i === 4) await descentViewer.page.screenshot({ path: testInfo.outputPath("6-descent-mid-390.png"), fullPage: false });
      await descentViewer.page.waitForTimeout(300);
    }
  };
  const otherPhones = viewers.filter((v) => v.width <= 700 && v !== descentViewer);
  await Promise.all([sampleDescent(), (async () => { for (const v of otherPhones) await revealGate(v); })()]);
  const descentStart = altitudes.findIndex((p, i) => i > 0 && p < altitudes[i - 1] - 1e-4);
  for (let i = Math.max(1, descentStart); i < altitudes.length; i++) {
    expect.soft(altitudes[i], `descent not monotone at sample ${i}: ${altitudes.join(", ")}`)
      .toBeLessThanOrEqual(altitudes[i - 1] + 0.004);
  }
  expect.soft(altitudes[altitudes.length - 1], `craft not parked at pad anchor: ${altitudes.join(", ")}`).toBe(0);
  expect.soft(altitudes[altitudes.length - 2], "craft must be constant once landed").toBe(0);
  await descentViewer.page.screenshot({ path: testInfo.outputPath("6-descent-parked-390.png"), fullPage: false });
  await revealGate(descentViewer);
  for (const v of viewers) if (v.width > 700) await revealGate(v);
  await capture("4-settled");

  // ── Phase 5: continue past the reveal to the intermission/return state. ──
  for (const v of viewers) {
    await v.game.locator(".private-reveal-continue").click({ timeout: 5_000 }).catch(() => {});
  }
  // The δ-lagged presentation (displayLagMs, default 1000ms) renders the
  // crash — and therefore starts the return descent — about δ later than the
  // raw settlement, so give the parked steady state that extra beat before
  // measuring the intermission geometry invariants.
  await viewers[0].page.waitForTimeout(4_000);
  await capture("5-intermission");

  // R6 + R3: the landed rocket (projected to screen space) must sit clear
  // BELOW the countdown card and the auto-launch caption.
  const parked = await readFlight();
  expect.soft(parked.p, "rocket must be parked (flightProgress 0) during intermission").toBe(0);
  expect.soft(parked.t, "descent target must be the pad anchor during intermission").toBe(0);
  // Same coordinate frame as measure(): the page may have been auto-scrolled
  // to bring the primary action into the thumb zone, and measure() reports
  // rects at scrollTop 0, so project the rocket at scrollTop 0 as well.
  const rocketScreen = await descentViewer.game.locator("body").evaluate((body) => {
    const w = window as unknown as { __plankRocketScreen?: () => { x: number; y: number } };
    const scroller = body.ownerDocument!.scrollingElement || body.ownerDocument!.documentElement;
    const prev = scroller.scrollTop; scroller.scrollTop = 0;
    const out = w.__plankRocketScreen ? w.__plankRocketScreen() : { x: 0, y: 1e9 };
    scroller.scrollTop = prev;
    return out;
  });
  const finalGeom = await measure(descentViewer.game);
  const cardRect = finalGeom.rects.countdown;
  const captionRect = finalGeom.rects.substatus;
  if (cardRect) expect.soft(rocketScreen.y, `parked rocket (${JSON.stringify(rocketScreen)}) overlaps countdown card ${JSON.stringify(cardRect)}`).toBeGreaterThan(cardRect.bottom + 8);
  if (captionRect) expect.soft(rocketScreen.y, `parked rocket (${JSON.stringify(rocketScreen)}) overlaps caption ${JSON.stringify(captionRect)}`).toBeGreaterThan(captionRect.bottom + 8);

  for (const v of viewers) await v.close();
  await hostContext.close();
});
