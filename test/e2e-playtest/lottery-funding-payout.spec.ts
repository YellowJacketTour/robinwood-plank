import { expect, test, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * REQUIREMENT: "ensure the lottery does get funded and ensure if there is a
 * lottery funded it can and does pay out."
 *
 * Proven through the REAL server path (Next.js routes -> lib/playtest-rooms.ts
 * transactions -> real PostgreSQL; nothing mocked), under the 2026-09-05 law
 * (docs/marketplank/RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md):
 *
 *  (a) FUNDING -- every qualified settled round routes exactly
 *      community-leg x powerboardFundingBps into the prize pool, net of the
 *      10% inflow fee, at once. A 2 x 10,000-credit round: rake 900 ->
 *      community 360 -> powerboardFundingAdded 234 -> pool +211.
 *
 *  (b) THE GENESIS ROUND HAS NO DRAW -- nothing was on the board before it
 *      (prize snapshot): lotteryEvent "funding", drawActive false, no winner,
 *      even when the host explicitly asks for a "hit".
 *
 *  (c) EVERY LATER ROUND IS A DRAW among that round's seats, priced by the
 *      round's own contribution: the settled event carries the exact
 *      threshold, the committed sample and the prize it drew for; a natural
 *      hit is exactly sample < threshold and the permissionless keeper
 *      derives that same outcome.
 *
 *  (d) A HIT PAYS EXACTLY W -- the winner (a seat of THAT round) is credited
 *      the carve's winner take of the prize that was on the board, and the
 *      next board opens at exactly S plus the hit round's own contribution.
 *      Nothing is forced; a host-forced laboratory hit is flagged.
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
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, json };
  }, { method, path, body });
}

const uuid = () => crypto.randomUUID();

async function command(page: Page, roomId: string, body: Json, allow: string[] = []): Promise<{ status: number; json: Json }> {
  const result = await api(page, "POST", `/api/playtest/rooms/${roomId}/commands`, { commandId: uuid(), ...body });
  if (result.status !== 200 && !allow.includes(String(result.json.error))) {
    throw new Error(`${String(body.action)} failed: ${JSON.stringify(result.json)}`);
  }
  return result;
}

async function snapshot(page: Page, roomId: string): Promise<Json> {
  const result = await api(page, "GET", `/api/playtest/rooms/${roomId}`);
  expect(result.status).toBe(200);
  return result.json;
}

function lotteryState(snap: Json): Json {
  return ((snap.simulation as Json).lottery ?? {}) as Json;
}

/** Bet for both players, start, then settle with the requested lab outcome
 * as soon as the committed crash instant passes. Returns the settled event
 * payload plus the fresh snapshot. */
async function runRound(host: Page, guest: Page, roomId: string, lotteryOutcome: "none" | "miss" | "hit") {
  for (const page of [host, guest]) {
    await command(page, roomId, { action: "bet", stake: "10000", targetBps: "15000", autoLockEnabled: true });
  }
  await command(host, roomId, { action: "start" });
  const deadline = Date.now() + 180_000;
  for (;;) {
    const result = await command(host, roomId, { action: "settle", lotteryOutcome }, ["ROUND_ACTIVE", "NOT_RUNNING"]);
    if (result.status === 200) break;
    if (String(result.json.error) === "NOT_RUNNING") break; // keeper is off (no page open) — should not happen
    if (Date.now() > deadline) throw new Error("round never became settleable");
    await host.waitForTimeout(1_500);
  }
  const snap = await snapshot(host, roomId);
  const payload = ((snap.currentSettlement as Json | null)?.payload ?? {}) as Json;
  return { snap, payload };
}

test("lottery funding accrues per qualified round; the genesis round never draws; a funded prize pays exactly W to a seat of the drawing round", async ({ browser }) => {
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

  const created = await api(host, "POST", "/api/playtest/rooms", { action: "create", name: `Lottery ${stamp}` });
  expect(created.status).toBe(201);
  const roomId = String(created.json.id);

  const invite = await api(host, "POST", "/api/playtest/invites", { roomId });
  const inviteToken = new URL(String(invite.json.url)).searchParams.get("invite")!;
  await guest.goto("/playtest");
  const joined = await api(guest, "POST", "/api/playtest/session", {
    action: "register", displayName: `Punter ${stamp}`, pin: "4321", invite: inviteToken,
  });
  expect(joined.status, JSON.stringify(joined.json)).toBe(201);

  // -- (a)+(b) GENESIS: funded, no draw, even though the host demands a hit. --
  const before = lotteryState(await snapshot(host, roomId));
  expect(String(before.pool)).toBe("0");
  const round1 = await runRound(host, guest, roomId, "hit");
  expect(round1.payload.qualified).toBe(true);
  expect(String(round1.payload.powerboardFundingAdded), "65% of the community leg routed to the prize").toBe("234");
  expect(round1.payload.lotteryEvent, "nothing was on the board before the genesis round").toBe("funding");
  const genesisDraw = (round1.payload.powerboardDraw ?? {}) as Json;
  expect(genesisDraw.drawActive).toBe(false);
  expect(genesisDraw.payableHit).toBe(false);
  expect(round1.payload.lotteryWinner).toBeNull();
  const afterR1 = lotteryState(round1.snap);
  expect(String(afterR1.pool), "234 gross - 10% fee = 211 banked at once").toBe("211");
  expect(String(afterR1.committedPrize), "the board is set at settlement").toBe("211");

  // -- (c) EVERY later round is a priced draw (natural), keeper-derived. --
  const round2 = await runRound(host, guest, roomId, "none");
  expect(["hit", "miss"]).toContain(String(round2.payload.lotteryEvent));
  const draw2 = (round2.payload.powerboardDraw ?? {}) as Json;
  expect(draw2.drawActive).toBe(true);
  expect(String(round2.payload.lotteryPrize), "drew for the prize that was on the board").toBe("211");
  const PROB_ONE = 10n ** 18n;
  expect(BigInt(String(draw2.thresholdE18)), "a 211-credit prize is in the flat regime: 1 in 16").toBe(PROB_ONE / 16n);
  const naturalHit = BigInt(String(draw2.sampleE18)) < BigInt(String(draw2.thresholdE18));
  expect(draw2.naturalHit).toBe(naturalHit);
  expect(round2.payload.lotteryEvent).toBe(naturalHit ? "hit" : "miss");
  expect(draw2.forcedForSimulation, "a natural draw is never flagged as forced").toBe(false);

  // -- put a real prize on the board through the host console laboratory
  // injection (the REAL admin.simulation path) and settle a draw round. --
  await command(host, roomId, { action: "adminSimulation", simulation: { "lottery.pool": "90000" } });
  const boardBefore = lotteryState(await snapshot(host, roomId));
  expect(String(boardBefore.committedPrize)).toBe("90000");
  const balancesBefore = new Map((((await snapshot(host, roomId)).members ?? []) as Json[]).map((m) => [String(m.id), BigInt(String(m.balance))]));

  // -- (d) forced laboratory hit: pays exactly W(90,000) to a seat of THIS round. --
  const jackpot = await runRound(host, guest, roomId, "hit");
  expect(jackpot.payload.lotteryEvent).toBe("hit");
  const draw = (jackpot.payload.powerboardDraw ?? {}) as Json;
  expect(draw.drawActive).toBe(true);
  expect(draw.payableHit).toBe(true);
  // 90,000 credits against a 234-credit contribution: the actuarial branch binds (below 1 in 16).
  const threshold = BigInt(String(draw.thresholdE18));
  expect(threshold).toBeLessThan(PROB_ONE / 16n);
  expect(threshold).toBe((234n * PROB_ONE * 10_000n) / (20_000n * 76_236n));
  const natural = BigInt(String(draw.sampleE18)) < threshold;
  expect(draw.naturalHit).toBe(natural);
  expect(draw.forcedForSimulation, "forced exactly when the sample would not have hit").toBe(!natural);
  // S(90,000) = 13,764 -> W = 76,236: displayed == redeemable.
  expect(String(jackpot.payload.lotteryWinnerPaid)).toBe("76236");
  expect(String(jackpot.payload.lotterySeeded)).toBe("13764");
  const winner = (jackpot.payload.lotteryWinner ?? null) as Json | null;
  expect(winner, "a hit names a paid winner").toBeTruthy();
  expect(BigInt(String(winner!.payout))).toBe(76_236n);
  expect(String(winner!.round)).toBe(String((jackpot.snap.room as Json).currentRound));
  const roundSeatIds = ((jackpot.snap.seats ?? []) as Json[]).map((seat) => String(seat.userId));
  expect(roundSeatIds, "round-only eligibility: the winner sat in the drawing round").toContain(String(winner!.userId));

  // Ledger: the jackpot lands on the winner balance through the real member row.
  const balancesAfter = new Map(((jackpot.snap.members ?? []) as Json[]).map((m) => [String(m.id), BigInt(String(m.balance))]));
  const winnerId = String(winner!.userId);
  const winnerSeat = ((jackpot.snap.seats ?? []) as Json[]).find((seat) => String(seat.userId) === winnerId);
  const crashDelta = BigInt(String(winnerSeat?.payout ?? "0")) - 10_000n; // seat stake was escrowed at bet time
  expect(balancesAfter.get(winnerId)! - balancesBefore.get(winnerId)!).toBe(76_236n + crashDelta);

  // The next board: exactly S plus the hit round's own net contribution (211).
  const afterState = lotteryState(jackpot.snap);
  expect(String(afterState.pool)).toBe(String(13_764n + 211n));
  expect(String(afterState.committedPrize)).toBe(String(13_764n + 211n));
  expect(String(jackpot.payload.lotteryPrizeAfter)).toBe(String(13_764n + 211n));
  expect(BigInt(String(afterState.hits))).toBeGreaterThanOrEqual(1n);

  console.log(`funding/round=234 (net 211) prize=90000 W=76236 S=13764 threshold=${threshold} natural=${natural} winner=${winner!.displayName}`);

  await hostContext.close();
  await guestContext.close();
});
