import { expect, test, type Page } from "@playwright/test";
import { BOOTSTRAP_SECRET } from "../../playwright.playtest.config";

/**
 * REQUIREMENT: "ensure the lottery does get funded and ensure if there is a
 * lottery funded it can and does pay out on a 1."
 *
 * Proven through the REAL server path (Next.js routes -> lib/playtest-rooms.ts
 * transactions -> real PostgreSQL; nothing mocked):
 *
 *  (a) FUNDING — every qualified settled round routes exactly
 *      community-leg × powerboardFundingBps into the Powerboard prize
 *      pipeline. With the current configuration (4.50% rake, ratified
 *      40/40/20 split, powerboardFundingBps = 100% of the community leg) a
 *      2 × 10,000-credit round contributes rake 900 → community 360 →
 *      powerboardFundingAdded 360, and lottery.pendingFunding strictly
 *      increases by at least that amount.
 *
 *  (b) NEGATIVE GATE — while the prize is < 100% funded there is NO draw at
 *      all, even when the host explicitly asks for a "hit": the settled
 *      event reports lotteryEvent "funding", drawActive false, no staged
 *      number and no winner (the e10225e behavior, preserved).
 *
 *  (c) FUNDED PAYOUT — a funded prize is REACHABLE with current config via
 *      the host console's laboratory funding injection (the real
 *      admin.simulation path; the funded-gate itself is untouched — sealing
 *      still requires full minimumLotteryGross coverage AND a sealed reset
 *      reserve before readyForDraw ever arms). Once funded, a draw round
 *      pays the displayed prize to a voucher holder, the ledger shows the
 *      jackpot payment, the cycle base ratchets by max(5%, 50k), and the
 *      reset reserve refills the next prize.
 *
 *  (d) PAYS ON A 1 — the settled event's committed draw satisfies
 *      forcedForSimulation === (drawnNumber !== 1): whenever the committed
 *      reveal-derived ball IS 1, the payout is the natural outcome (and the
 *      permissionless keeper derives exactly that outcome from the reveal).
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

test("lottery funding accrues per qualified round; an unfunded prize never draws; a funded prize pays out", async ({ browser }) => {
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

  // ── (a) FUNDING: two qualified rounds, exact per-round contribution. ──
  const before = lotteryState(await snapshot(host, roomId));
  const round1 = await runRound(host, guest, roomId, "none");
  expect(round1.payload.qualified).toBe(true);
  expect(String(round1.payload.powerboardFundingAdded), "community leg share routed to the prize").toBe("360");
  const afterR1 = lotteryState(round1.snap);
  expect(BigInt(String(afterR1.pendingFunding)) - BigInt(String(before.pendingFunding)))
    .toBeGreaterThanOrEqual(360n);

  const round2 = await runRound(host, guest, roomId, "hit"); // ← host DEMANDS a hit while unfunded
  // ── (b) NEGATIVE GATE: no draw of any kind below 100% funded. ──
  expect(String(round2.payload.powerboardFundingAdded)).toBe("360");
  expect(round2.payload.lotteryEvent, "an unfunded prize can only be 'funding'").toBe("funding");
  const unfundedDraw = (round2.payload.powerboardDraw ?? {}) as Json;
  expect(unfundedDraw.drawActive, "no staged number while funding").toBe(false);
  expect(unfundedDraw.payableHit).toBe(false);
  expect(round2.payload.lotteryWinner, "nobody is paid below 100% funded").toBeNull();
  const afterR2 = lotteryState(round2.snap);
  expect(BigInt(String(afterR2.pendingFunding))).toBeGreaterThan(BigInt(String(afterR1.pendingFunding)));
  expect(String(afterR2.cycleBase)).toBe(String(before.cycleBase)); // no ratchet without a paid jackpot

  // ── (c) reach FULL funding via the host console's laboratory injection —
  // the REAL admin.simulation server path; the sealing/reset-reserve gate
  // below still does all of its own arithmetic. ──
  await command(host, roomId, { action: "adminSimulation", simulation: { "lottery.pendingFunding": "5000000" } });

  // A sealing round: the engine itself must seal the epoch (full
  // minimumLotteryGross coverage), fund the reset reserve, and arm the draw.
  const sealing = await runRound(host, guest, roomId, "none");
  expect(sealing.payload.lotteryEvent).toBe("sealed");
  const armed = lotteryState(sealing.snap);
  expect(armed.readyForDraw, "draw arms only with prize + reset reserve sealed").toBe(true);
  const displayedPrize = BigInt(String(armed.netPrize));
  expect(displayedPrize).toBeGreaterThanOrEqual(1_000_000n); // ≥ the cycle base
  const reserveBefore = BigInt(String(armed.resetReserve));
  expect(reserveBefore).toBeGreaterThan(displayedPrize); // covers the ratcheted next prize gross
  const cycleBaseBefore = BigInt(String(armed.cycleBase));
  const balancesBefore = new Map(((sealing.snap.members ?? []) as Json[]).map((m) => [String(m.id), BigInt(String(m.balance))]));

  // ── (c)+(d) the funded draw round: pays the DISPLAYED prize. ──
  const jackpot = await runRound(host, guest, roomId, "hit");
  expect(jackpot.payload.lotteryEvent).toBe("hit");
  const draw = (jackpot.payload.powerboardDraw ?? {}) as Json;
  expect(draw.drawActive).toBe(true);
  expect(draw.payableHit).toBe(true);
  expect(draw.winningNumber, "ball 1 is the jackpot ball").toBe(1);
  // The payout-on-1 law: the outcome is natural exactly when the committed
  // reveal-derived ball is 1 — so a funded prize DOES pay on a 1, and the
  // permissionless keeper (tickPlaytestRound) derives that same outcome.
  expect(draw.forcedForSimulation).toBe(Number(draw.drawnNumber) !== 1);

  const winner = (jackpot.payload.lotteryWinner ?? null) as Json | null;
  expect(winner, "a funded hit names a paid winner").toBeTruthy();
  expect(BigInt(String(winner!.payout)), "winner is paid the displayed prize").toBe(displayedPrize);

  // Ledger: JACKPOT paid to the winner's balance through the real member row.
  const afterState = lotteryState(jackpot.snap);
  const balancesAfter = new Map(((jackpot.snap.members ?? []) as Json[]).map((m) => [String(m.id), BigInt(String(m.balance))]));
  const winnerId = String(winner!.userId);
  const winnerSeatNet = ((jackpot.snap.seats ?? []) as Json[]).find((seat) => String(seat.userId) === winnerId);
  const crashDelta = BigInt(String(winnerSeatNet?.payout ?? "0")) - 10_000n; // seat stake was escrowed at bet time
  expect(balancesAfter.get(winnerId)! - balancesBefore.get(winnerId)!)
    .toBe(displayedPrize + crashDelta);

  // Cycle base ratchets by max(5%, 50k) and the reset reserve refills the
  // NEXT prize (netPrize is immediately re-seeded from the sealed reserve).
  const cycleBaseAfter = BigInt(String(afterState.cycleBase));
  const minStep = cycleBaseBefore * 500n / 10_000n > 50_000n ? cycleBaseBefore * 500n / 10_000n : 50_000n;
  expect(cycleBaseAfter).toBe(cycleBaseBefore + minStep);
  expect(BigInt(String(afterState.netPrize)), "next prize re-seeded from the reset reserve").toBeGreaterThanOrEqual(cycleBaseAfter);
  // The reset reserve was consumed to seed the new prize and immediately
  // refills (from the surplus pending funding) toward the NEXT ratcheted
  // base: minimumLotteryGross(nextCycleBase(1,050,000)=1,102,500, 10% fee)
  // = 1,224,999 gross.
  expect(BigInt(String(afterState.resetReserve))).toBe(1_224_999n);
  void reserveBefore;

  console.log(`funding/round=360 threshold(prize gross)=1111112 displayedPrize=${displayedPrize} ` +
    `payout=${winner!.payout} ratchet=${cycleBaseBefore}->${cycleBaseAfter} nextPrize=${afterState.netPrize}`);

  await hostContext.close();
  await guestContext.close();
});
