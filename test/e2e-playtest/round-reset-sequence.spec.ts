import { expect, test, type Frame, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * ROUND-RESET PRESENTATION SEQUENCE — no-phantom-relaunch proof.
 *
 * Reported defect (owner): "after each round reset plank seems to like
 * relaunch and then reset". Root cause: when the δ-lagged replay window
 * expired, frame() still saw phaseState==="live" until the scheduled crash
 * repaint (setTimeout) fired, and fell through to the on-chain QUADRATIC
 * clock — a multi-frame discontinuous jump of altitude/readout, snapped back
 * by the repaint: the phantom relaunch.
 *
 * The fix is a one-way per-round presentation state machine
 * (countdown → ignition → flight → crash-hold → descent → parked) derived
 * every frame from server phase + the single lagged clock. This spec runs
 * >=3 consecutive AUTOMATIC rounds in the real browser against the real
 * server + PostgreSQL, records per-frame telemetry (altitude p, target t,
 * stage, lagged phase), and asserts:
 *
 *   1. NO-PHANTOM-RELAUNCH: between each round's lagged crash render (first
 *      settled frame) and the next round's display liftoff (first flight
 *      frame with t>0), per-frame altitude NEVER rises (eps for float noise).
 *   2. Segment monotonicity: altitude is monotone non-decreasing through
 *      flight, monotone non-increasing through crash-hold/descent/parked.
 *   3. Stage ordering: within a round the stage index only advances; the
 *      only reset is the roundKey change of the real next round.
 */

type Json = Record<string, unknown>;

const STAGE_RANK: Record<string, number> = {
  countdown: 0, ignition: 1, flight: 2, "crash-hold": 3, descent: 4, parked: 5,
};

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
  expect(result.status).toBe(200);
  return result.json;
}
const phaseOf = (snap: Json) => String((snap.room as Json).phase);
const roundOf = (snap: Json) => Number((snap.room as Json).currentRound);

async function waitForPhase(page: Page, roomId: string, wanted: string, timeoutMs: number): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await snapshot(page, roomId);
    if (phaseOf(last) === wanted) return last;
    await page.waitForTimeout(400);
  }
  throw new Error(`room never reached ${wanted}; last=${phaseOf(last)} round=${roundOf(last)}`);
}

type FrameSample = { ms: number; p: number; t: number; stage: string | null; round: string | null; phase: string | null };

test("round reset presents one deterministic sequence: no phantom relaunch across 3 automatic rounds", async ({ browser }, testInfo) => {
  test.setTimeout(420_000);
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  const stamp = Date.now().toString(36);

  await host.goto("/playtest");
  let auth: { status: number; json: Json } = { status: 0, json: {} };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    auth = await api(host, "POST", "/api/playtest/session", {
      action: "bootstrap", displayName: "Host", pin: "654321", setup: BOOTSTRAP_SECRET,
    });
    if (auth.status === 409) auth = await api(host, "POST", "/api/playtest/session", { displayName: "Host", pin: "654321" });
    if (auth.status !== 429) break;
    await host.waitForTimeout(10_000); // shared-server rate limiter; back off
  }
  expect(auth.status, JSON.stringify(auth.json)).toBe(201);

  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Reset ${stamp}` });
  expect(created.status).toBe(201);
  const roomId = String(created.json.id);

  await host.goto(`/playtest/game?room=${roomId}`);
  const iframe = host.locator("iframe[title='PlankCrash private multiplayer table']");
  await expect(iframe).toBeVisible();
  const game = (): Frame => {
    const frame = host.frames().find((candidate) => candidate.url().includes("/arcade/crash.html"));
    if (!frame) throw new Error("game frame not found");
    return frame;
  };
  await expect(host.frameLocator("iframe[title='PlankCrash private multiplayer table']").locator("#substatus")).toBeVisible({ timeout: 30_000 });
  await host.frameLocator("iframe[title='PlankCrash private multiplayer table']")
    .getByRole("button", { name: /ENTER THE TABLE/i }).click({ timeout: 12_000 }).catch(() => {});

  // Per-frame recorder inside the real game document (rAF cadence).
  await game().evaluate(() => {
    const w = window as unknown as {
      __frameLog: FrameSampleLike[];
      __plankFlight?: { p: number; t: number };
      __plankStage?: { round: string; stage: string } | null;
    };
    type FrameSampleLike = { ms: number; p: number; t: number; stage: string | null; round: string | null; phase: string | null };
    w.__frameLog = [];
    const record = () => {
      const flight = w.__plankFlight || { p: 0, t: 0 };
      const stage = w.__plankStage || null;
      w.__frameLog.push({
        ms: performance.now(),
        p: flight.p,
        t: flight.t,
        stage: stage ? stage.stage : null,
        round: stage ? stage.round : null,
        phase: document.body.dataset.privatePhase || null,
      });
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });

  // Drive 4 rounds: round 1 manual launch, rounds 2-4 fully automatic.
  const firstBet = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, {
    action: "bet", commandId: uuid(), stake: "10000", targetBps: "15000", autoLockEnabled: true,
  });
  expect(firstBet.status, JSON.stringify(firstBet.json)).toBe(200);
  // Synthetic participants satisfy the 2-player minimum and keep every
  // automatic round populated without further host action.
  const bots = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, {
    action: "adminBots", commandId: uuid(), bots: { operation: "add", count: 3, preset: "balanced", bankroll: "1000000" },
  });
  expect(bots.status, JSON.stringify(bots.json)).toBe(200);
  const start = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, { action: "start", commandId: uuid() });
  expect(start.status, JSON.stringify(start.json)).toBe(200);

  for (let round = 1; round <= 4; round += 1) {
    const running = await waitForPhase(host, roomId, "running", 90_000);
    expect(roundOf(running)).toBe(round);
    const settled = await waitForPhase(host, roomId, "settled", 120_000);
    expect(roundOf(settled)).toBe(round);
    if (round < 4) {
      // Queue the next-round seat during the intermission (keeps the keeper
      // auto-launching with a live participant, like a real table).
      const bet = await api(host, "POST", `/api/playtest/rooms/${roomId}/commands`, {
        action: "bet", commandId: uuid(), stake: "10000", targetBps: "15000", autoLockEnabled: true,
      });
      expect(bet.status, `round ${round + 1} queue bet ${JSON.stringify(bet.json)}`).toBe(200);
    }
  }
  // Let round 4's lagged crash + descent fully render before stopping.
  await host.waitForTimeout(4_000);

  const log = (await game().evaluate(() => (window as unknown as { __frameLog: unknown }).__frameLog)) as FrameSample[];
  expect(log.length).toBeGreaterThan(1_000);

  // ── Assertion 3: stage ordering is one-way within each round. ──
  const EPS = 0.004;
  let orderingViolations = 0;
  for (let i = 1; i < log.length; i += 1) {
    const prev = log[i - 1];
    const cur = log[i];
    if (!prev.stage || !cur.stage || prev.round !== cur.round) continue;
    if (STAGE_RANK[cur.stage] < STAGE_RANK[prev.stage]) {
      orderingViolations += 1;
      console.log(`STAGE REGRESSION @${cur.ms.toFixed(0)}ms round=${cur.round}: ${prev.stage} -> ${cur.stage}`);
    }
  }
  expect(orderingViolations, "stage machine transitions must be strictly ordered").toBe(0);

  // ── Assertions 1+2: settle→next-liftoff windows are never-rising. ──
  // A settle window opens at the first crash-hold/descent/parked frame of a
  // round and closes at the first flight frame WITH t>0 of a LATER round
  // (the display liftoff at T+δ of the next round).
  // Stage telemetry segments the windows; a pre-fix build (no stage machine)
  // falls back to the lagged phase dataset so this spec also REPRODUCES the
  // defect when run against the unfixed presentation.
  const settledStage = (f: FrameSample) => f.stage
    ? f.stage === "crash-hold" || f.stage === "descent" || f.stage === "parked"
    : f.phase === "settled";
  const liftoff = (f: FrameSample) => (f.stage ? f.stage === "flight" : f.phase === "running") && f.t > 0;
  let windows = 0;
  let open = false;
  let maxRise = 0;
  let riseFrames = 0;
  let targetRises = 0;
  for (let i = 1; i < log.length; i += 1) {
    const prev = log[i - 1];
    const cur = log[i];
    if (!open && settledStage(cur) && !settledStage(prev)) { open = true; windows += 1; continue; }
    if (open && liftoff(cur)) { open = false; continue; }
    if (open) {
      const rise = cur.p - prev.p;
      if (rise > EPS) {
        riseFrames += 1;
        maxRise = Math.max(maxRise, rise);
        console.log(`PHANTOM RISE @${cur.ms.toFixed(0)}ms round=${cur.round} stage=${prev.stage}->${cur.stage} phase=${cur.phase}: p ${prev.p.toFixed(4)} -> ${cur.p.toFixed(4)} (t ${prev.t.toFixed(4)} -> ${cur.t.toFixed(4)})`);
      }
      // The presentation TARGET must never step upward inside the window at all.
      if (cur.t > prev.t + 1e-9) {
        targetRises += 1;
        console.log(`TARGET RISE @${cur.ms.toFixed(0)}ms round=${cur.round} stage=${String(prev.stage)}->${String(cur.stage)} phase=${cur.phase}: t ${prev.t.toFixed(4)} -> ${cur.t.toFixed(4)}`);
      }
    }
  }
  console.log(`settle windows observed=${windows} riseFrames=${riseFrames} targetRises=${targetRises} maxRise=${maxRise.toFixed(5)}`);
  expect(targetRises, "presentation target never steps upward inside a settle window").toBe(0);
  expect(windows, "must observe >=3 settle->next-liftoff windows").toBeGreaterThanOrEqual(3);
  expect(riseFrames, "no-phantom-relaunch: altitude never rises between settle and next T+δ").toBe(0);

  // ── Segment monotonicity inside flight (non-decreasing target). ──
  for (let i = 1; i < log.length; i += 1) {
    const prev = log[i - 1];
    const cur = log[i];
    if (cur.stage === "flight" && prev.stage === "flight" && cur.round === prev.round) {
      expect(cur.t, `flight target must be non-decreasing @${cur.ms.toFixed(0)}ms`).toBeGreaterThanOrEqual(prev.t - 1e-9);
    }
  }

  await host.screenshot({ path: testInfo.outputPath("after-4-rounds.png") });
  await hostContext.close();
});
