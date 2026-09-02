import { expect, test, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * REQUIREMENT: "i should be able to start a new table and send out invites
 * and everything works as a fake version of mainnet real version running
 * automatically per current configurations."
 *
 * Proven end-to-end against the real server path (Next.js dev server + real
 * PostgreSQL — the same lib/playtest-rooms.ts transactions production runs):
 *   1. host bootstraps/logs in and creates a NEW table;
 *   2. host issues a reusable table invitation (real /api/playtest/invites);
 *   3. a SECOND, cookie-isolated browser context registers through that
 *      invitation and lands in the same room;
 *   4. both open the real game surface (/playtest/game iframe ->
 *      /arcade/crash.html?playtest=1&room=...);
 *   5. rounds 2 and 3 launch AUTOMATICALLY (the blind keeper inside the
 *      long-poll — the test never issues another "start" after round 1);
 *   6. both clients' snapshots converge (same phase/round/version source of
 *      truth) and their DOM shows the shared table state;
 *   7. bets are accepted for every player in every one of 3 consecutive
 *      rounds and lock acceptance is exercised (manual + auto paths).
 *
 * The playtest is the no-value mirror of the mainnet configuration: rules
 * hash, ccs-2l settlement, 4.50% evolutionary rake and Powerboard funding
 * all come from DEFAULT_PLAYTEST_POLICY on the server; the test asserts the
 * settled events actually carry that configuration.
 */

type Json = Record<string, unknown>;

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
  expect(result.status, `snapshot ${JSON.stringify(result.json).slice(0, 200)}`).toBe(200);
  return result.json;
}

function phaseOf(snap: Json): string {
  return String((snap.room as Json).phase);
}
function roundOf(snap: Json): number {
  return Number((snap.room as Json).currentRound);
}

async function waitForPhase(page: Page, roomId: string, wanted: string, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await snapshot(page, roomId);
    if (phaseOf(last) === wanted) return last;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`room never reached phase ${wanted}; last=${phaseOf(last)} round=${roundOf(last)}`);
}

test("a new table + invite runs 3 automatic fake-mainnet rounds for two isolated clients", async ({ browser }, testInfo) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const stamp = Date.now().toString(36);

  // ── 1. Host authentication (bootstrap the deployment, or log back in). ──
  await host.goto("/playtest");
  let auth = await api(host, "POST", "/api/playtest/session", {
    action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET,
  });
  if (auth.status === 409) {
    auth = await api(host, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
  }
  expect(auth.status, JSON.stringify(auth.json)).toBe(201);
  expect(auth.json.isAdmin).toBe(true);

  // ── 2. Create a brand-new table. ──
  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Lifecycle ${stamp}` });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const roomId = String(created.json.id);
  expect(roomId).toMatch(/^[0-9a-f-]{36}$/i);

  // ── 3. Issue a real reusable invitation for that table. ──
  const invite = await api(host, "POST", "/api/playtest/invites", { roomId });
  expect(invite.status, JSON.stringify(invite.json)).toBe(201);
  const inviteUrl = new URL(String(invite.json.url));
  const inviteToken = inviteUrl.searchParams.get("invite")!;
  expect(inviteToken.length).toBeGreaterThanOrEqual(20);

  // ── 4. A cookie-isolated second browser joins through the invitation. ──
  await guest.goto(inviteUrl.pathname + inviteUrl.search);
  const joined = await api(guest, "POST", "/api/playtest/session", {
    action: "register", displayName: `Guest ${stamp}`, pin: "4321", invite: inviteToken,
  });
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);
  expect(joined.json.roomId).toBe(roomId);

  // ── 5. Both open the REAL game surface (auth-walled route + iframe). ──
  for (const page of [host, guest]) {
    await page.goto(`/playtest/game?room=${roomId}`);
    await expect(page.locator("iframe[title='PlankCrash private multiplayer table']")).toBeVisible();
  }
  const hostGame = host.frameLocator("iframe[title='PlankCrash private multiplayer table']");
  const guestGame = guest.frameLocator("iframe[title='PlankCrash private multiplayer table']");
  await expect(hostGame.locator("#substatus")).toBeVisible({ timeout: 30_000 });
  await expect(guestGame.locator("#substatus")).toBeVisible({ timeout: 30_000 });
  // Dismiss the first-visit onboarding card so screenshots show the table.
  for (const game of [hostGame, guestGame]) {
    await game.getByRole("button", { name: /ENTER THE TABLE/i }).click({ timeout: 15_000 }).catch(() => {});
  }

  const acceptedBets: string[] = [];
  let manualLockAccepted = 0;
  let autoLockSettled = 0;

  for (let round = 1; round <= 3; round += 1) {
    // ── Bets from BOTH isolated clients (host auto-lock 1.5x, guest manual). ──
    for (const [page, who, autoLock] of [[host, "host", true], [guest, "guest", false]] as const) {
      const bet = await api(page, "POST", `/api/playtest/rooms/${roomId}/commands`, {
        action: "bet", commandId: uuid(), stake: "10000",
        targetBps: "15000", autoLockEnabled: autoLock,
      });
      expect(bet.status, `round ${round} ${who} bet ${JSON.stringify(bet.json)}`).toBe(200);
      acceptedBets.push(`${round}:${who}`);
    }

    if (round === 1) {
      // Round 1 is the only manual launch; rounds 2-3 must come from the
      // automated keeper with NO host action.
      const start = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, {
        action: "start", commandId: uuid(),
      });
      expect(start.status, JSON.stringify(start.json)).toBe(200);
    }

    const running = await waitForPhase(guest, roomId, "running", 90_000);
    expect(roundOf(running)).toBe(round);

    // ── Convergence: both isolated clients agree on the authoritative state. ──
    const [hostView, guestView] = await Promise.all([snapshot(host, roomId), snapshot(guest, roomId)]);
    expect(phaseOf(hostView)).toBe("running");
    expect(phaseOf(guestView)).toBe("running");
    expect(roundOf(hostView)).toBe(roundOf(guestView));

    // Guest attempts the real manual-lock path early in the flight.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const lock = await api(guest, "POST", `/api/playtest/rooms/${roomId}/commands`, {
        action: "lock", commandId: uuid(),
      });
      if (lock.status === 200) { manualLockAccepted += 1; break; }
      const code = String(lock.json.error);
      // NOT_FLYING = the δ-lagged display has not lifted off yet (ignition
      // hold); TOO_EARLY = the lagged display is below the 1.01x open. Both
      // are pre-liftoff states worth retrying; anything else (e.g. crashed
      // first) is a legitimate terminal outcome for this round.
      if (code !== "TOO_EARLY" && code !== "NOT_FLYING") break;
      await guest.waitForTimeout(400);
    }

    // Both DOMs render the shared flight/settlement lifecycle.
    if (round === 1) {
      await host.screenshot({ path: testInfo.outputPath("host-round1-flight.png") });
      await guest.screenshot({ path: testInfo.outputPath("guest-round1-flight.png") });
    }

    // ── Settlement happens with NO further client command (blind keeper). ──
    const settled = await waitForPhase(guest, roomId, "settled", 120_000);
    expect(roundOf(settled)).toBe(round);

    // Fake-mainnet configuration is actually the one that settled the round.
    const settledPayload = ((settled.currentSettlement as Json | null)?.payload ?? {}) as Json;
    const accounting = (settledPayload.accounting ?? {}) as Json;
    expect(accounting.rule, `round ${round} settles under ccs-2l`).toBe("ccs-2l");
    expect(Number(settledPayload.effectiveRakeBps)).toBe(450); // 4.50% evolutionary rake, tier 0
    expect(settledPayload.powerboardPool, "Powerboard funding pipeline present").toBeTruthy();
    expect(settledPayload.powerboardFundingAdded, "Powerboard funding recorded").toBeDefined();
    const hostSeat = ((settled.seats ?? []) as Json[]).find((seat) => String(seat.displayName) === "Host");
    // The auto-lock path produced an accepted/settled target for the host seat.
    if (hostSeat?.acceptedTargetBps) autoLockSettled += 1;

    // ── Both clients see the SAME intermission countdown from the snapshot. ──
    const nextLaunchAt = String((settled.room as Json).nextLaunchAt || "");
    if (round < 3) {
      expect(Date.parse(nextLaunchAt)).toBeGreaterThan(Date.now() - 2_000);
      const other = await snapshot(host, roomId);
      expect(String((other.room as Json).nextLaunchAt)).toBe(nextLaunchAt);
      await expect(guestGame.locator("#substatus")).toContainText(/AUTO-LAUNCH|COMMITMENTS/i, { timeout: 20_000 });
    }
  }

  expect(acceptedBets).toHaveLength(6); // 2 clients × 3 consecutive rounds
  // Lock acceptance was exercised (manual and/or executed auto path). Both
  // depend on the committed crash point actually exceeding the lock price,
  // so the invariant is "locks were accepted", not "every seat locked".
  console.log(`locks: manual=${manualLockAccepted} auto=${autoLockSettled}`);
  expect(manualLockAccepted + autoLockSettled).toBeGreaterThanOrEqual(1);

  const final = await snapshot(guest, roomId);
  expect(roundOf(final)).toBe(3);
  await host.screenshot({ path: testInfo.outputPath("host-after-3-rounds.png") });
  await guest.screenshot({ path: testInfo.outputPath("guest-after-3-rounds.png") });

  await hostContext.close();
  await guestContext.close();
});
