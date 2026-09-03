import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * CONTROL INVENTORY — every player-relevant control and accessory on the
 * playtest game surface (public/arcade/crash.html inside /playtest/game) is
 * PRESENT, REACHABLE and FUNCTIONAL on mobile and desktop, through THREE
 * automatic rounds against the real server + real PostgreSQL (no mocks).
 *
 * Inventory: docs/marketplank/CONTROL-INVENTORY-playtest-2026-09-03.md
 *
 * Two sessions only (registration is rate-limited per IP): ONE host (desktop
 * context, resized 1280x720 -> 1920x1080) and ONE guest (iPhone-class mobile
 * context: touch, DSF 3, mobile UA, resized 390x844 -> 430x932).
 *
 * Per phase and viewport every inventory row is asserted:
 *   PRESENT    visible;
 *   REACHABLE  min bounding-box dimension >= 44px on mobile, centre point
 *              not occluded by another element, and the LOCK button centre
 *              inside the bottom 45% of the mobile viewport during flight;
 *   FUNCTIONAL the control produces the expected SERVER-side effect
 *              (commit -> seat in snapshot; lock -> acceptedTargetBps; auto-lock
 *              chip -> committed autoLockEnabled flips; custom stake -> exact
 *              stake committed; target amendment -> requestedTargetBps changes;
 *              REPEAT -> next-round seat re-queued with the same stake/target;
 *              queue -> nextRoundSeats contains me).
 */

type Json = Record<string, unknown>;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const GAME_FRAME = "iframe[title='PlankCrash private multiplayer table']";
const MOBILE_VIEWPORTS = [{ w: 390, h: 844 }, { w: 430, h: 932 }] as const;
const DESKTOP_VIEWPORTS = [{ w: 1280, h: 720 }, { w: 1920, h: 1080 }] as const;

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
const room = (snap: Json) => snap.room as Json;
const meId = (snap: Json) => String((snap.me as Json).id);
const mySeat = (snap: Json) => ((snap.seats as Json[]) || []).find((s) => s.userId === meId(snap)) || null;
const myQueued = (snap: Json) => ((snap.nextRoundSeats as Json[]) || []).find((s) => s.userId === meId(snap)) || null;

async function snapshot(page: Page, roomId: string): Promise<Json> {
  const result = await api(page, "GET", `/api/playtest/rooms/${roomId}`);
  expect(result.status, JSON.stringify(result.json).slice(0, 200)).toBe(200);
  return result.json;
}
async function waitForPhase(page: Page, roomId: string, wanted: string, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await snapshot(page, roomId);
    if (String(room(last).phase) === wanted) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`room never reached ${wanted}; last=${String(room(last).phase)}`);
}
async function waitUntil(page: Page, roomId: string, pred: (s: Json) => boolean, what: string, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await snapshot(page, roomId);
    if (pred(last)) return last;
    await page.waitForTimeout(300);
  }
  throw new Error(`timed out waiting for ${what}; phase=${String(room(last).phase)} seats=${JSON.stringify(last.seats)} next=${JSON.stringify(last.nextRoundSeats)}`);
}

// ── Inventory rows: selector + the phases in which each must be PRESENT. ──
// phase keys: lobby | committed | flight | locked | settled | intermission
type Row = { id: string; selector: string; phases: string[]; interactive: boolean; sheet?: boolean; thumb?: boolean; dim?: boolean; mobileOnly?: boolean };
const ROWS: Row[] = [
  // Stake entry is state-disabled (dimmed) outside the betting window but must stay present.
  { id: "stake-chips", selector: "#stakeRow .chip[data-amt]", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, dim: true },
  { id: "custom-stake", selector: "#privateCustomStake", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, dim: true },
  { id: "balance", selector: "#privateBalanceReadout", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "auto-lock-chip", selector: "#privateAutoLockChip", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true },
  { id: "target-input", selector: "#autoTargetInput", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true },
  { id: "repeat", selector: "#autoToggle", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true },
  { id: "primary", selector: "#primaryBtn", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, thumb: true },
  { id: "primary-sub", selector: "#btnSub", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "mult-readout", selector: "#multReadout", phases: ["flight", "locked"], interactive: false },
  { id: "substatus", selector: "#substatus", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "result-card", selector: "#resultCard.show", phases: ["settled"], interactive: false },
  { id: "countdown", selector: "#privateIntermissionCountdown", phases: ["intermission"], interactive: false },
  { id: "journey", selector: "#privateJourney", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "hud-status", selector: "#privateHudStatus", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "table-toggle", selector: "#privateTableToggle", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, mobileOnly: true },
  { id: "roster", selector: "#privateRoster .private-player", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false, sheet: true },
  { id: "phase-guide", selector: "#privatePhaseGuide", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false, sheet: true },
  { id: "invite-code", selector: "#privateJoinCode", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false, sheet: true },
  { id: "copy-link", selector: "#privateCodeCopy", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, sheet: true },
  { id: "how-to-play", selector: "#privateHowButton", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, sheet: true },
  { id: "game-menu", selector: "#privateMenuButton", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, sheet: true },
  { id: "leave-table", selector: "#privateLeaveTable", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, sheet: true },
  { id: "system-math", selector: ".private-host-actions a[href*='plankcrash-system']", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true, sheet: true },
  { id: "powerboard", selector: "#pbStat", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true },
  { id: "vault", selector: "#vaultStat", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "rtp", selector: "#rankStat", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: false },
  { id: "sound", selector: "#sfxBtn", phases: ["lobby", "committed", "flight", "locked", "intermission"], interactive: true },
];

type Measure = { present: boolean; rect: { l: number; t: number; w: number; h: number } | null; minDim: number; occluded: string | null; inViewport: boolean; text: string };

async function measureRows(game: FrameLocator, rows: Row[]): Promise<Record<string, Measure>> {
  return game.locator("body").evaluate((body, rows) => {
    const doc = body.ownerDocument!; const win = doc.defaultView!;
    const vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    const visible = (el: Element, dim = false) => {
      const s = win.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || (!dim && Number(s.opacity) < 0.5)) return false;
      const cv = (el as HTMLElement).checkVisibility;
      if (typeof cv === "function" && !(el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const out: Record<string, Measure> = {};
    for (const row of rows) {
      const el = Array.from(doc.querySelectorAll(row.selector)).find((candidate) => visible(candidate, Boolean(row.dim))) || null;
      if (!el) { out[row.id] = { present: false, rect: null, minDim: 0, occluded: null, inViewport: false, text: "" }; continue; }
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const inViewport = cx >= 0 && cx <= vw && cy >= 0 && cy <= vh;
      let occluded: string | null = null;
      if (inViewport && row.interactive) {
        const hit = doc.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          occluded = `${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}.${String(hit.className).split(" ")[0] || ""}`;
        }
      }
      out[row.id] = {
        present: true,
        rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        minDim: Math.min(r.width, r.height), occluded, inViewport,
        text: ((el as HTMLElement).innerText || (el as HTMLInputElement).value || "").slice(0, 80),
      };
    }
    return out;
  }, rows);
}

async function setSheet(game: FrameLocator, open: boolean): Promise<void> {
  const toggle = game.locator("#privateTableToggle");
  if (!(await toggle.isVisible().catch(() => false))) return;
  const expanded = (await toggle.getAttribute("aria-expanded")) === "true";
  // Reachability of the toggle is measured separately (elementFromPoint); the
  // open/close itself dispatches the event so a mid-animation hit-target
  // check can never stall the run.
  if (expanded !== open) { await toggle.dispatchEvent("click"); await game.locator("body").page().waitForTimeout(350); }
}

type Surface = { label: string; mobile: boolean; page: Page; game: FrameLocator; w: number; h: number };
const failures: string[] = [];
let manualLockProven = false;

async function auditPhase(s: Surface, phase: string, testInfo: { outputPath: (n: string) => string }): Promise<Record<string, Measure>> {
  await s.page.screenshot({ path: testInfo.outputPath(`${phase}-${s.label}.png`), fullPage: false });
  const rows = ROWS.filter((r) => r.phases.includes(phase) && (s.mobile || !r.mobileOnly));
  const main = await measureRows(s.game, rows.filter((r) => !r.sheet));
  let sheet: Record<string, Measure> = {};
  if (s.mobile) {
    await setSheet(s.game, true);
    await s.page.screenshot({ path: testInfo.outputPath(`${phase}-${s.label}-sheet.png`), fullPage: false });
    sheet = await measureRows(s.game, rows.filter((r) => r.sheet));
    await setSheet(s.game, false);
  } else {
    sheet = await measureRows(s.game, rows.filter((r) => r.sheet));
  }
  const all = { ...main, ...sheet };
  for (const row of rows) {
    const m = all[row.id];
    const tag = `${phase}@${s.label}:${row.id}`;
    if (!m?.present) { failures.push(`${tag} NOT PRESENT`); continue; }
    if (s.mobile && row.interactive && m.minDim < 44) failures.push(`${tag} touch target ${m.minDim.toFixed(0)}px < 44px ${JSON.stringify(m.rect)}`);
    if (m.occluded) failures.push(`${tag} occluded by ${m.occluded} ${JSON.stringify(m.rect)}`);
    // The controls the player must act on during THIS phase have to be on screen without scrolling.
    const critical = row.id === "primary" || row.id === "countdown" || row.id === "result-card" || row.id === "mult-readout";
    if (critical && !m.inViewport) failures.push(`${tag} not in viewport ${JSON.stringify(m.rect)} (${s.w}x${s.h})`);
    if (row.thumb && s.mobile && (phase === "flight") && m.rect && (m.rect.t + m.rect.h / 2) < s.h * 0.55) {
      failures.push(`${tag} LOCK centre y=${(m.rect.t + m.rect.h / 2).toFixed(0)} not in bottom 45% of ${s.h}px viewport`);
    }
  }
  return all;
}

test.use({ actionTimeout: 15_000, navigationTimeout: 60_000 });

test("every player control is present, reachable and functional on mobile + desktop through 3 automatic rounds", async ({ browser }, testInfo) => {
  test.setTimeout(1_200_000);

  // ── Host: desktop context. ──
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage();
  await host.goto("/playtest");
  let auth = await api(host, "POST", "/api/playtest/session", { action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET });
  if (auth.status === 409) auth = await api(host, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
  expect(auth.status, JSON.stringify(auth.json)).toBe(201);
  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Control inventory ${Date.now().toString(36)}` });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const roomId = String(created.json.id);
  const invite = await api(host, "POST", "/api/playtest/invites", { roomId });
  expect(invite.status, JSON.stringify(invite.json)).toBe(201);
  const inviteUrl = new URL(String(invite.json.url));

  // ── Guest: ONE mobile context reused across both mobile viewports. ──
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IPHONE_UA });
  const guest = await guestContext.newPage();
  await guest.goto(inviteUrl.pathname + inviteUrl.search);
  const joined = await api(guest, "POST", "/api/playtest/session", { action: "register", displayName: `Guest ${Date.now().toString(36)}`, pin: "4321", invite: inviteUrl.searchParams.get("invite") });
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);

  const open = async (page: Page): Promise<FrameLocator> => {
    await page.goto(`/playtest/game?room=${roomId}`);
    const game = page.frameLocator(GAME_FRAME);
    await expect(game.locator("#substatus")).toBeVisible({ timeout: 30_000 });
    await game.getByRole("button", { name: /ENTER THE TABLE/i }).click({ timeout: 8_000 }).catch(() => {});
    await expect(game.locator("#primaryBtn")).not.toHaveText(/CONNECTING/, { timeout: 30_000 });
    return game;
  };
  const mobile: Surface = { label: "m390", mobile: true, page: guest, game: await open(guest), w: 390, h: 844 };
  const desktop: Surface = { label: "d1280", mobile: false, page: host, game: await open(host), w: 1280, h: 720 };
  const setViewport = async (s: Surface, v: { w: number; h: number }, label: string) => {
    await s.page.setViewportSize({ width: v.w, height: v.h }); s.w = v.w; s.h = v.h; s.label = label; await s.page.waitForTimeout(400);
  };
  const surfaces = [mobile, desktop];
  const audit = async (phase: string) => { for (const s of surfaces) await auditPhase(s, phase, testInfo); };

  // ══ ROUND 1 (lobby -> host launch) ══
  await audit("lobby");

  // FUNCTIONAL: custom stake entry on mobile (exact credits committed) + preset chip on desktop.
  const customStake = "1234";
  const customInput = mobile.game.locator("#privateCustomStake");
  if (await customInput.isVisible().catch(() => false)) {
    await customInput.fill(customStake); await customInput.dispatchEvent("change");
  } else {
    failures.push("lobby@m390:custom-stake NOT FUNCTIONAL (control missing)");
    await mobile.game.locator("#stakeRow .chip[data-amt]").nth(1).click();
  }
  // Target input + auto-lock chip before commit.
  await mobile.game.locator("#autoTargetInput").fill("3.5"); await mobile.game.locator("#autoTargetInput").dispatchEvent("change");
  const chipText = await mobile.game.locator("#privateAutoLockChip").innerText();
  if (!/✓/.test(chipText)) await mobile.game.locator("#privateAutoLockChip").click();
  await mobile.game.locator("#primaryBtn").click();
  await expect(mobile.game.locator("#primaryBtn")).toHaveText(/READY FOR ROUND 1/, { timeout: 15_000 });
  let snapG = await waitUntil(guest, roomId, (s) => Boolean(mySeat(s)), "guest seat", 15_000);
  const seatG = mySeat(snapG)!;
  if (await customInput.isVisible().catch(() => false)) expect.soft(seatG.stake, "custom stake committed exactly").toBe(customStake);
  expect.soft(seatG.requestedTargetBps, "target committed with bet").toBe("35000");
  expect.soft(seatG.autoLockEnabled, "auto-lock committed with bet").toBe(true);
  // Committed-state indicator shows stake + armed target through the wait.
  const subText = await mobile.game.locator("#btnSub").innerText();
  if (!/3\.50/.test(subText)) failures.push(`committed@m390:primary-sub does not show armed target (got "${subText}")`);
  // FUNCTIONAL: auto-lock chip disarm = real server amendment pre-launch.
  await mobile.game.locator("#privateAutoLockChip").click();
  snapG = await waitUntil(guest, roomId, (s) => mySeat(s)?.autoLockEnabled === false, "auto-lock disarmed server-side", 10_000);
  await expect(mobile.game.locator("#privateAutoLockChip")).toHaveText(/AUTO-LOCK OFF/);
  // FUNCTIONAL: amending the cash-out target pre-launch re-commits the seat.
  await mobile.game.locator("#autoTargetInput").fill("2.5"); await mobile.game.locator("#autoTargetInput").dispatchEvent("change");
  try { await waitUntil(guest, roomId, (s) => mySeat(s)?.requestedTargetBps === "25000", "target amended", 8_000); }
  catch { failures.push("committed@m390:target-input NOT FUNCTIONAL (pre-launch target change not re-committed)"); }
  // No second COMMIT is offered for an already-committed seat.
  await expect(mobile.game.locator("#primaryBtn")).toBeDisabled();

  // Desktop host commits with a preset chip and auto-lock ARMED at 1.5x.
  await desktop.game.locator("#stakeRow .chip[data-amt]").nth(2).click();
  await desktop.game.locator("#autoTargetInput").fill("1.5"); await desktop.game.locator("#autoTargetInput").dispatchEvent("change");
  if (!/✓/.test(await desktop.game.locator("#privateAutoLockChip").innerText())) await desktop.game.locator("#privateAutoLockChip").click();
  await desktop.game.locator("#primaryBtn").click();
  const snapH = await waitUntil(host, roomId, (s) => Boolean(mySeat(s)), "host seat", 15_000);
  expect.soft(mySeat(snapH)!.stake, "preset chip stake committed").toBe("5000");
  expect.soft(mySeat(snapH)!.autoLockEnabled).toBe(true);
  await audit("committed");

  // Host launches round 1 via the real LAUNCH control.
  await desktop.game.locator("#privateLaunch").click();
  await waitForPhase(host, roomId, "running", 60_000);

  const flightAndSettle = async (round: number, manualLocker: Surface, viewportTag: string) => {
    // Wait for the lagged display to lift off (lock opens at 1.01x): the
    // primary action becomes the live LOCK control naming its multiplier.
    // A flight can crash inside the 1.5s pre-roll + δ display lag (e.g. 1.09×
    // lasts ~400ms), in which case LOCK NOW never has a frame to render. That
    // is the law, not a defect: tolerate it here; the lock proof is still
    // required from at least one of the three rounds (see manualLockProven).
    const liftoff = await (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const label = await manualLocker.game.locator("#primaryBtn").innerText().catch(() => "");
        if (/LOCK NOW/.test(label)) return true;
        const s = await snapshot(manualLocker.page, roomId);
        if (String(room(s).phase) === "settled") return false;
        await manualLocker.page.waitForTimeout(150);
      }
      return false;
    })();
    if (!liftoff) console.log(`[control-inventory] round ${round}@${viewportTag}: crashed before the lagged liftoff rendered; flight audit skipped for this round`);
    if (liftoff) {
    await expect(manualLocker.game.locator("#primaryBtn")).toBeEnabled({ timeout: 5_000 });
    // Flights can last only a few seconds: audit the locker's own deck in
    // one beat (screenshot + geometry), then LOCK immediately.
    const flightRows = ROWS.filter((r) => r.phases.includes("flight") && !r.sheet && (manualLocker.mobile || !r.mobileOnly));
    const flightGeom = await measureRows(manualLocker.game, flightRows);
    const before = await snapshot(manualLocker.page, roomId);
    let tapped = false;
    if (String(room(before).phase) === "running" && mySeat(before) && !mySeat(before)!.acceptedTargetBps) {
      await manualLocker.game.locator("#primaryBtn").click({ timeout: 3_000 }).catch(() => {});
      tapped = true;
    }
    await manualLocker.page.screenshot({ path: testInfo.outputPath(`flight-${manualLocker.label}.png`), fullPage: false });
    const lockLabel = flightGeom.primary?.text || "";
    // The LOCK button must show the live (lagged) multiplier it will grant.
    if (!/LOCK NOW · \d+\.\d\d×/.test(lockLabel)) failures.push(`flight@${manualLocker.label}:primary LOCK label lacks live multiplier ("${lockLabel}")`);
    for (const row of flightRows) {
      const m = flightGeom[row.id]; const tag = `flight@${manualLocker.label}:${row.id}`;
      if (!m?.present) { failures.push(`${tag} NOT PRESENT`); continue; }
      if (manualLocker.mobile && row.interactive && m.minDim < 44) failures.push(`${tag} touch target ${m.minDim.toFixed(0)}px < 44px ${JSON.stringify(m.rect)}`);
      if (m.occluded) failures.push(`${tag} occluded by ${m.occluded} ${JSON.stringify(m.rect)}`);
      if ((row.id === "primary" || row.id === "mult-readout") && !m.inViewport) failures.push(`${tag} not in viewport ${JSON.stringify(m.rect)}`);
      if (row.thumb && manualLocker.mobile && m.rect && (m.rect.t + m.rect.h / 2) < manualLocker.h * 0.55) failures.push(`${tag} LOCK centre y=${(m.rect.t + m.rect.h / 2).toFixed(0)} not in bottom 45% of ${manualLocker.h}px viewport`);
    }
    // FUNCTIONAL: manual lock -> server grants acceptedTargetBps.
    if (tapped) {
      const after = await waitUntil(manualLocker.page, roomId, (s) => Boolean(mySeat(s)?.acceptedTargetBps) || String(room(s).phase) !== "running", "lock result", 20_000);
      const granted = mySeat(after)?.acceptedTargetBps;
      if (granted) {
        manualLockProven = true;
        expect.soft(Number(granted), `round ${round}: granted lock ≥ 1.01x`).toBeGreaterThanOrEqual(10_100);
        await expect.soft(manualLocker.game.locator("#btnSub")).toHaveText(new RegExp(`${(Number(granted) / 10_000).toFixed(2)}`), { timeout: 5_000 });
        await expect.soft(manualLocker.game.locator("#primaryBtn")).toBeDisabled();
        if (String(room(after).phase) === "running") {
          await manualLocker.page.screenshot({ path: testInfo.outputPath(`locked-${manualLocker.label}.png`), fullPage: false });
          const lockedGeom = await measureRows(manualLocker.game, flightRows.filter((r) => r.id === "primary" || r.id === "primary-sub" || r.id === "mult-readout"));
          if (!lockedGeom.primary?.present) failures.push(`locked@${manualLocker.label}:primary NOT PRESENT`);
          if (!/Locked at \d+\.\d\d×/.test(lockedGeom["primary-sub"]?.text || "")) failures.push(`locked@${manualLocker.label}:primary-sub lacks "Locked at x.xx×" (${lockedGeom["primary-sub"]?.text})`);
        }
      } else {
        // Crash beat the tap (flights can be a couple of seconds): the UI must
        // fall closed -- no LOCK still offered after settlement -- and the
        // server's rejection must surface. Proof of a granted manual lock is
        // required from at least one of the three rounds.
        await manualLocker.page.waitForTimeout(1_500);
        const label = await manualLocker.game.locator("#primaryBtn").innerText();
        const enabled = await manualLocker.game.locator("#primaryBtn").isEnabled();
        if (/LOCK NOW/.test(label) && enabled) failures.push(`round ${round}@${viewportTag}: LOCK still offered after the crash ("${label}")`);
        console.log(`[control-inventory] round ${round}@${viewportTag}: manual tap raced the crash; UI fell closed ("${label}")`);
      }
    }
    } // liftoff
    const settled = await waitForPhase(host, roomId, "settled", 120_000);
    // Reveal card: crash multiplier, own lock, payout, net.
    for (const s of surfaces) await expect(s.game.locator("#resultCard.show")).toBeVisible({ timeout: 30_000 });
    await audit("settled");
    const crash = (Number(room(settled).crashBps) / 10_000).toFixed(2);
    for (const s of surfaces) {
      const text = await s.game.locator("#resultCard").innerText();
      if (!text.includes(`${crash}×`)) failures.push(`settled@${s.label}:result-card lacks crash multiplier ${crash}× ("${text.slice(0, 120)}")`);
      if (!/credits (paid|lost)|watched/i.test(text)) failures.push(`settled@${s.label}:result-card lacks payout line`);
    }
    for (const s of surfaces) {
      await s.game.locator(".private-reveal-skip").click({ timeout: 5_000 }).catch(() => {});
      await s.game.locator(".private-reveal-continue").click({ timeout: 5_000 }).catch(() => {});
    }
    await host.waitForTimeout(3_500);
    await audit("intermission");
    for (const s of surfaces) {
      const sub = await s.game.locator("#substatus").innerText();
      if (!/AUTO-LAUNCH IN/.test(sub) || !/COMMITMENTS CLOSE AT LAUNCH/.test(sub)) failures.push(`intermission@${s.label}:substatus lacks auto-launch notice ("${sub}")`);
    }
  };

  await flightAndSettle(1, mobile, "m390");

  // ══ INTERMISSION 1 -> ROUND 2: queue next-round commitments through the UI; switch viewports. ══
  await setViewport(mobile, MOBILE_VIEWPORTS[1], "m430");
  await setViewport(desktop, DESKTOP_VIEWPORTS[1], "d1920");
  await audit("intermission");
  // Guest arms REPEAT (auto re-commit of the same stake/target) instead of committing by hand.
  await mobile.game.locator("#autoToggle").click();
  let queuedG: Json | null = null;
  try {
    queuedG = myQueued(await waitUntil(guest, roomId, (s) => Boolean(myQueued(s)), "REPEAT queued guest seat", 12_000));
  } catch { failures.push("intermission@m430:repeat NOT FUNCTIONAL (REPEAT did not queue the next-round commitment)"); }
  if (!queuedG) {
    await mobile.game.locator("#autoToggle").click().catch(() => {});
    await mobile.game.locator("#primaryBtn").click();
    queuedG = myQueued(await waitUntil(guest, roomId, (s) => Boolean(myQueued(s)), "guest queued seat", 12_000));
  } else {
    expect.soft(queuedG.stake, "REPEAT re-queues the same stake").toBe(seatG.stake);
  }
  await expect(mobile.game.locator("#primaryBtn")).toHaveText(/READY FOR ROUND 2/, { timeout: 8_000 });
  // Desktop host commits by hand for round 2 with auto-lock DISARMED (it is
  // the manual locker this round) and a high target; roster on the other
  // surface must show the queue.
  await desktop.game.locator("#autoTargetInput").fill("50"); await desktop.game.locator("#autoTargetInput").dispatchEvent("change");
  if (/✓/.test(await desktop.game.locator("#privateAutoLockChip").innerText())) await desktop.game.locator("#privateAutoLockChip").click();
  await desktop.game.locator("#primaryBtn").click();
  await waitUntil(host, roomId, (s) => Boolean(myQueued(s)), "host queued seat", 12_000);
  await setSheet(mobile.game, true);
  await expect.soft(mobile.game.locator("#privateRoster")).toContainText(/Ready round 2/, { timeout: 8_000 });
  await setSheet(mobile.game, false);
  await audit("committed");
  await waitForPhase(host, roomId, "running", 90_000);
  await flightAndSettle(2, desktop, "d1920");

  // ══ INTERMISSION 2 -> ROUND 3: guest REPEAT stays armed; host commits by hand; back to first viewports. ══
  await setViewport(mobile, MOBILE_VIEWPORTS[0], "m390");
  await setViewport(desktop, DESKTOP_VIEWPORTS[0], "d1280");
  try { await waitUntil(guest, roomId, (s) => Boolean(myQueued(s)), "REPEAT queued round 3", 12_000); }
  catch { failures.push("intermission@m390:repeat NOT FUNCTIONAL for round 3"); await mobile.game.locator("#primaryBtn").click(); await waitUntil(guest, roomId, (s) => Boolean(myQueued(s)), "guest queued 3", 12_000); }
  await desktop.game.locator("#primaryBtn").click();
  await waitUntil(host, roomId, (s) => Boolean(myQueued(s)), "host queued 3", 12_000);
  await audit("committed");
  await waitForPhase(host, roomId, "running", 90_000);
  await flightAndSettle(3, mobile, "m390");
  if (!manualLockProven) failures.push("manual LOCK was never granted in three rounds (every tap raced the crash)");

  // Powerboard status control opens its ledger popover.
  await desktop.game.locator("#pbStat").click();
  await expect.soft(desktop.game.locator("#pbPopover")).toBeVisible({ timeout: 5_000 });
  await desktop.game.locator("#pbPopClose").click().catch(() => {});
  // Sound toggle flips aria-pressed.
  const pressed = await mobile.game.locator("#sfxBtn").getAttribute("aria-pressed");
  await mobile.game.locator("#sfxBtn").click();
  expect.soft(await mobile.game.locator("#sfxBtn").getAttribute("aria-pressed"), "sound toggle flips").not.toBe(pressed);
  // How-to-play + game menu + invite dialog open from the table sheet on mobile.
  await setSheet(mobile.game, true);
  await mobile.game.locator("#privateHowButton").click();
  await expect.soft(mobile.game.locator("#privateHow")).toBeVisible();
  await mobile.game.locator("#privateHow .private-how-close").click();
  await mobile.game.locator("#privateMenuButton").click();
  await expect.soft(mobile.game.locator("#privateMenu")).toBeVisible();
  await mobile.game.locator("#privateMenuClose").click();
  if (await mobile.game.locator("#privateCodeCopy").isEnabled()) failures.push("copy-link is offered to a guest although only the host can issue invitation links");
  await expect.soft(mobile.game.locator("#privateJoinCode")).toHaveText(/^[A-Z2-9]{8}$/);
  await desktop.game.locator("#privateCodeCopy").click();
  await desktop.page.waitForTimeout(2_000);
  const inviteValue = await desktop.game.locator("#privateInviteUrl").inputValue().catch(() => "");
  const toastText = await desktop.game.locator("#toastLog").innerText().catch(() => "");
  if (!/invite=/.test(inviteValue) && !/invit|Too many|rate/i.test(toastText)) failures.push(`copy-link (host) produced neither an invitation nor an honest refusal (toast="${toastText.slice(0, 80)}")`);
  await desktop.game.locator("#privateInviteClose").click({ timeout: 3_000 }).catch(() => {});
  await setSheet(mobile.game, false);

  console.log(`[control-inventory] ${failures.length} gap(s):\n${failures.map((f) => "  - " + f).join("\n")}`);
  expect(failures, failures.join("\n")).toEqual([]);
  await guestContext.close(); await hostContext.close();
});
