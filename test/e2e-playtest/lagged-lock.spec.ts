import { expect, test, type Frame, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * LATENCY-LAGGED PRESENTATION + HONEST LOCK GRANT — end-to-end proof against
 * the real server path (Next.js + real PostgreSQL, no mocks):
 *
 *   A. WHAT-YOU-SEE-IS-WHAT-YOU-GET: a manual lock is granted at exactly
 *      m(arrival − δ) — the multiplier an honest δ-lagged display was showing
 *      at the tap — and the SETTLED seat carries that same granted value
 *      (displayed == redeemable), PAID (survived) because arrival preceded
 *      the crash and the lagged grant is therefore always below the crash.
 *   B. FAST-OBSERVER REJECTION: continuously spamming lock through the whole
 *      flight, no request whose server arrival is at/after the authoritative
 *      crash ever succeeds — the raw-feed watcher gains nothing.
 *   C. PRESENTATION: the rocket holds on the pad at 1.00x for the published
 *      δ after the authoritative launch (ignition hold), and the results
 *      theater does not appear before the lagged crash has rendered.
 */

type Json = Record<string, unknown>;

const GROWTH = 0.22;
const bpsAt = (elapsedMs: number) => Math.floor(10_000 * Math.exp(GROWTH * Math.max(0, elapsedMs) / 1_000));

async function api(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try { json = await response.json(); } catch { /* empty body */ }
    return { status: response.status, json };
  }, { method, path, body });
}

const uuid = () => crypto.randomUUID();

async function snapshot(page: Page, roomId: string): Promise<Json> {
  const result = await api(page, "GET", `/api/playtest/rooms/${roomId}`);
  expect(result.status, JSON.stringify(result.json).slice(0, 200)).toBe(200);
  return result.json;
}

const room = (snap: Json) => snap.room as Json;

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

test("honest lagged lock: displayed == granted == settled; arrival after crash always rejects", async ({ browser }, testInfo) => {
  test.setTimeout(420_000);
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const stamp = Date.now().toString(36);

  await host.goto("/playtest");
  let auth = await api(host, "POST", "/api/playtest/session", {
    action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET,
  });
  if (auth.status === 409) auth = await api(host, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
  expect(auth.status, JSON.stringify(auth.json)).toBe(201);

  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Lagged ${stamp}` });
  expect(created.status).toBe(201);
  const roomId = String(created.json.id);
  const invite = await api(host, "POST", "/api/playtest/invites", { roomId });
  expect(invite.status).toBe(201);
  const inviteUrl = new URL(String(invite.json.url));
  await guest.goto(inviteUrl.pathname + inviteUrl.search);
  const joined = await api(guest, "POST", "/api/playtest/session", {
    action: "register", displayName: `Lag Guest ${stamp}`, pin: "4321", invite: inviteUrl.searchParams.get("invite")!,
  });
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);

  // Open the real game surface on the guest so C's DOM proofs run on it.
  await guest.goto(`/playtest/game?room=${roomId}`);
  await expect(guest.locator("iframe[title='PlankCrash private multiplayer table']")).toBeVisible();
  const gameFrame = (): Frame => {
    const frame = guest.frames().find((candidate) => candidate.url().includes("/arcade/crash.html"));
    if (!frame) throw new Error("game frame not found");
    return frame;
  };
  await expect(guest.frameLocator("iframe[title='PlankCrash private multiplayer table']").locator("#substatus"))
    .toBeVisible({ timeout: 30_000 });

  // The published room constant δ.
  const first = await snapshot(guest, roomId);
  const displayLagMs = Number(room(first).displayLagMs);
  expect(displayLagMs, "δ is a published room constant").toBeGreaterThanOrEqual(600);
  expect(displayLagMs).toBeLessThanOrEqual(2_000);

  let wysiwygProven = false;
  let fastObserverRejections = 0;
  let postCrashSuccesses = 0;
  let ignitionHoldProven = false;
  let modalSequencingChecked = false;

  let modalTimingProven = false;
  for (let round = 1; round <= 8 && !(wysiwygProven && ignitionHoldProven && modalTimingProven); round += 1) {
    for (const [page, who] of [[host, "host"], [guest, "guest"]] as const) {
      const bet = await api(page, "POST", `/api/playtest/rooms/${roomId}/commands`, {
        action: "bet", commandId: uuid(), stake: "10000", targetBps: "990000", autoLockEnabled: false,
      });
      expect(bet.status, `round ${round} ${who} bet ${JSON.stringify(bet.json)}`).toBe(200);
    }
    if (round === 1) {
      const start = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "start", commandId: uuid() });
      expect(start.status, JSON.stringify(start.json)).toBe(200);
    }
    const running = await waitForPhase(guest, roomId, "running", 90_000);
    const startedAtMs = Date.parse(String(room(running).startedAt));
    const offsetMs = Date.parse(String(running.serverNow)) - Date.now();
    const serverNow = () => Date.now() + offsetMs;

    // ── C1. IGNITION HOLD (once): during [T, T+δ) a live-rendering client
    // shows exactly 1.00x — the rocket burns on the pad, altitude zero. ──
    if (!ignitionHoldProven) {
      while (serverNow() < startedAtMs + displayLagMs - 300) {
        const state = await gameFrame().evaluate(() => ({
          phase: document.body.dataset.privatePhase || "",
          readout: (document.getElementById("multReadout")?.textContent || "").replace(/\s/g, ""),
        }));
        if (state.phase === "running" && serverNow() < startedAtMs + displayLagMs - 300 && serverNow() >= startedAtMs) {
          expect(state.readout, "rocket holds on the pad at 1.00x during the ignition hold").toMatch(/^1\.00x$/);
          ignitionHoldProven = true;
          break;
        }
        await guest.waitForTimeout(100);
      }
    }

    // Wait until the lagged display is clearly past liftoff, then tap once.
    while (serverNow() < startedAtMs + displayLagMs + 1_400) await guest.waitForTimeout(50);

    const sendServerMs = serverNow();
    const lock = await api(guest, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "lock", commandId: uuid() });
    const recvServerMs = serverNow();

    let grantedBps: number | null = null;
    if (lock.status === 200) {
      grantedBps = Number(lock.json.acceptedTargetBps ?? (lock.json as Json).acceptedTargetBps);
      if (!Number.isFinite(grantedBps)) grantedBps = Number(((lock.json.result ?? {}) as Json).acceptedTargetBps);
      expect(Number.isFinite(grantedBps), `lock result carries the grant: ${JSON.stringify(lock.json)}`).toBe(true);
      // ── A. WYSIWYG: the grant is exactly the lagged law m(arrival − δ),
      // with the arrival bracketed by this request's own send/receive window
      // (each bound widened by the clock-offset error budget).
      const SLACK_MS = 600;
      const low = bpsAt(sendServerMs - SLACK_MS - displayLagMs - startedAtMs);
      const high = bpsAt(recvServerMs + SLACK_MS - displayLagMs - startedAtMs);
      expect(grantedBps!, "grant ≥ the lagged display at send").toBeGreaterThanOrEqual(low);
      expect(grantedBps!, "grant ≤ the lagged display at receive").toBeLessThanOrEqual(high);
    }

    // ── B. FAST OBSERVER: spam lock until well after settlement. ──
    const attempts: Array<{ atServerMs: number; status: number; error: string; granted: number | null }> = [];
    let settledSnap: Json | null = null;
    const spamDeadline = Date.now() + 120_000;
    while (Date.now() < spamDeadline) {
      const at = serverNow();
      const attempt = await api(guest, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "lock", commandId: uuid() });
      attempts.push({
        atServerMs: at, status: attempt.status, error: String(attempt.json.error || ""),
        granted: attempt.status === 200 ? Number(attempt.json.acceptedTargetBps) : null,
      });
      const snap = await snapshot(guest, roomId);
      if (String(room(snap).phase) === "settled") { settledSnap = snap; break; }
      await guest.waitForTimeout(120);
    }
    expect(settledSnap, "the round settles under the blind keeper").toBeTruthy();
    const crashAtMs = Date.parse(String(room(settledSnap!).crashAt));
    const crashBps = Number(room(settledSnap!).crashBps);
    expect(Number.isFinite(crashAtMs)).toBe(true);

    for (const attempt of attempts) {
      if (attempt.status === 200) {
        expect(attempt.granted!, "no accepted grant ever reaches the crash multiplier").toBeLessThan(crashBps);
      } else if (attempt.atServerMs >= crashAtMs + 600 /* offset error budget */) {
        // Arrival provably after the authoritative crash: ALWAYS rejected,
        // even though its lagged grant would have been far below the crash.
        expect(["TOO_LATE", "NOT_RUNNING", "NO_ACTIVE_BET"], `post-crash rejection ${attempt.error}`).toContain(attempt.error);
        fastObserverRejections += 1;
      }
      if (attempt.atServerMs >= crashAtMs + 600 && attempt.status === 200) postCrashSuccesses += 1;
    }

    // One more explicit fast-observer tap now that the crash is PUBLIC.
    const late = await api(guest, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "lock", commandId: uuid() });
    expect(late.status, "a lock after the revealed crash can never succeed").not.toBe(200);
    fastObserverRejections += 1;

    // ── C2. Results theater sequencing: the modal appears, but never before
    // the δ-lagged crash has rendered on the display clock. ──
    if (!modalTimingProven) {
      if (serverNow() < crashAtMs + displayLagMs - 300) {
        const shownEarly = await gameFrame().evaluate(() => document.getElementById("resultCard")?.classList.contains("show") ?? false);
        expect(shownEarly, "results modal must not appear before the lagged crash has rendered").toBe(false);
        modalSequencingChecked = true;
      }
      for (let i = 0; i < 150; i += 1) {
        const shown = await gameFrame().evaluate(() => document.getElementById("resultCard")?.classList.contains("show") ?? false);
        if (shown) {
          expect(serverNow(), "results modal first shows only after the lagged crash render")
            .toBeGreaterThanOrEqual(crashAtMs + displayLagMs - 400);
          modalTimingProven = true;
          break;
        }
        await guest.waitForTimeout(100);
      }
      expect(modalTimingProven, "the results modal does eventually appear after the lagged crash").toBe(true);
    }

    if (grantedBps !== null) {
      // ── A (settled receipt): displayed == redeemable. ──
      const seats = (settledSnap!.seats ?? []) as Json[];
      const mySeat = seats.find((seat) => String(seat.displayName).startsWith("Lag Guest"));
      expect(mySeat, "guest seat present at settlement").toBeTruthy();
      expect(Number(mySeat!.acceptedTargetBps), "settled receipt shows exactly the granted multiplier").toBe(grantedBps);
      expect(mySeat!.survived, "arrival before crash with a lagged grant below the crash is PAID").toBe(true);
      expect(BigInt(String(mySeat!.payout)) > 0n, "paid out at the granted multiplier").toBe(true);
      wysiwygProven = true;
      console.log(`WYSIWYG: round ${round} granted=${grantedBps} (=${(grantedBps / 10_000).toFixed(4)}x) crash=${crashBps} paid=${mySeat!.payout} δ=${displayLagMs}ms`);
    } else {
      console.log(`round ${round}: manual lock did not land (${JSON.stringify(lock.json)}); retrying next round`);
    }
  }

  expect(wysiwygProven, "a full displayed==granted==settled round was proven").toBe(true);
  expect(ignitionHoldProven, "the ignition hold (1.00x on the pad for δ) was observed in the DOM").toBe(true);
  expect(modalTimingProven, "modal-after-lagged-crash sequencing was proven").toBe(true);
  expect(postCrashSuccesses, "fast observer NEVER wins").toBe(0);
  expect(fastObserverRejections).toBeGreaterThanOrEqual(1);
  console.log(`fast-observer rejections observed: ${fastObserverRejections}; ignition-hold DOM proof: ${ignitionHoldProven}; modal sequencing checked: ${modalSequencingChecked}`);
  await guest.screenshot({ path: testInfo.outputPath("lagged-lock-final.png") });
  await hostContext.close();
  await guestContext.close();
});
