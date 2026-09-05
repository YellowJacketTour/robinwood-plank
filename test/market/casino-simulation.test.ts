import assert from "node:assert/strict";
import test from "node:test";
import {
  accountedAssets,
  carvePrize,
  evolutionQuote,
  hitThresholdE18,
  initialSimulationState,
  PROB_ONE,
  seededSimulationRandom,
  serializeSimulationState,
  simulateIteration,
  type SimulationPolicy,
} from "../../lib/casino/simulation.ts";

const ETH = 10n ** 18n;
const BPS = 10_000n;
const policy: SimulationPolicy = {
  rakeBps: 450n,
  rakeFloorBps: 250n,
  rakeStepBps: 25n,
  rakeVolumeStep: 25_000_000n,
  keeperRewardBps: 0n,
  protectedPrincipalBps: 2_500n,
  powerboardFundingBps: 2_500n,
  crashSeed: ETH / 100n,
  emissionBufferCap: ETH / 20n,
  lotteryFounderFeeBps: 500n,
  lotteryOddsOneIn: 16n,
  lotteryKappaBps: 20_000n,
  carveMinBps: 1_000n,
  carveMaxBps: 3_000n,
  carveHalfSaturation: ETH / 4n,
  allocationRule: "pfss",
  minimumPlayers: 2,
  minimumStake: ETH / 1_000n,
};

/** Global conservation: every wei that came in is somewhere we can name. */
function assertConserved(state: ReturnType<typeof initialSimulationState>, label: string) {
  assert.equal(
    state.totals.freshWagers + state.totals.externalLotteryFunding,
    state.totals.burned
      + state.totals.keeperRewards
      + state.totals.crashFounderRake
      + state.totals.lotteryFounderFees
      + state.totals.playerCrashPayouts
      + state.totals.lotteryWinnerPayouts
      + accountedAssets(state),
    `global conservation: ${label}`,
  );
}

test("non-qualifying iterations cannot manufacture community value", () => {
  const before = initialSimulationState(policy);
  const result = simulateIteration(before, policy, {
    players: [{ id: "solo", stake: policy.minimumStake, targetBps: 15_000n }],
    crashBps: 20_000n,
    lotteryOutcome: "none",
  });
  assert.equal(result.qualified, false);
  assert.equal(result.state.totals.freshWagers, 0n);
  assert.equal(accountedAssets(result.state), 0n);
  assert.equal(result.lotteryEvent, "none", "no draw without a qualified settlement");
});

test("ratified split, principal, emissions, and payouts conserve a qualified round; the lottery leg is fee-on-inflow", () => {
  const before = initialSimulationState(policy);
  const players = [
    { id: "a", stake: ETH, targetBps: 15_000n },
    { id: "b", stake: ETH, targetBps: 30_000n },
  ];
  const result = simulateIteration(before, policy, { players, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(result.state.totals.grossRake, (2n * ETH * 450n) / 10_000n);
  assert.equal(result.state.totals.burned, (result.state.totals.grossRake * 4_000n) / 10_000n);
  assert.equal(result.state.totals.communityFunded, (result.state.totals.grossRake * 4_000n) / 10_000n);
  assert.equal(result.state.totals.powerboardFunded, (result.state.totals.communityFunded * 2_500n) / 10_000n);
  assert.equal(
    result.state.totals.grossRake,
    result.state.totals.burned + result.state.totals.communityFunded + result.state.totals.crashFounderRake,
  );
  const c = result.state.totals.powerboardFunded;
  const fee = (c * policy.lotteryFounderFeeBps) / BPS;
  assert.equal(result.state.lottery.pool, c - fee, "the pool banks the contribution net of the founder fee, at once");
  assert.equal(result.state.totals.lotteryFounderFees, fee);
  assert.equal(result.state.lottery.committedPrize, c - fee, "the next draw pays what was banked at this settlement");
  assert.equal(result.lotteryEvent, "funding", "genesis: nothing was on the board before this round");
  assertConserved(result.state, "first round");
});

test("qualified volume permanently lowers rake without wallet-count or rank shortcuts", () => {
  const evolving: SimulationPolicy = {
    ...policy,
    allocationRule: "ccs-2l",
    minimumStake: 500n,
    crashSeed: 0n,
    rakeVolumeStep: 2_000n,
    rakeStepBps: 25n,
    rakeFloorBps: 400n,
  };
  const players = [
    { id: "a", stake: 1_000n, targetBps: 11_000n },
    { id: "b", stake: 1_000n, targetBps: 11_000n },
  ];
  let state = initialSimulationState(evolving);
  const first = simulateIteration(state, evolving, { players, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(first.effectiveRakeBps, 450n);
  assert.equal(first.settlement?.totalPayout, 1_910n);
  state = first.state;
  const second = simulateIteration(state, evolving, { players, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(second.effectiveRakeBps, 425n);
  assert.equal(second.settlement?.totalPayout, 1_915n);
  state = second.state;
  const third = simulateIteration(state, evolving, { players, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(third.effectiveRakeBps, 400n);
  assert.equal(third.settlement?.totalPayout, 1_920n);
  assert.equal(evolutionQuote(evolving, third.state.totals.freshWagers).effectiveRakeBps, 400n);

  const unqualified = simulateIteration(third.state, evolving, {
    players: [{ id: "sybil", stake: 499n, targetBps: 11_000n }],
    crashBps: 20_000n,
    lotteryOutcome: "none",
  });
  assert.equal(unqualified.qualified, false);
  assert.equal(unqualified.state.totals.freshWagers, third.state.totals.freshWagers);
  assert.equal(unqualified.effectiveRakeBps, 400n);
});

test("the carve is ONE floor division: W + S == P, both non-decreasing in P", () => {
  let prev = { winnerPaid: -1n, seeded: -1n };
  for (let e = 0; e <= 30; e += 1) {
    const P = 10n ** BigInt(e);
    const cur = carvePrize(P, policy);
    assert.equal(cur.winnerPaid + cur.seeded, P);
    assert.ok(cur.winnerPaid >= prev.winnerPaid && cur.seeded >= prev.seeded, `monotone at 1e${e}`);
    prev = cur;
  }
  assert.deepEqual(carvePrize(0n, policy), { winnerPaid: 0n, seeded: 0n });
});

test("the actuarial hit rule: min(flat, c/(kappa W)); E[payout] <= c/kappa; a quiet round is negative-EV at every prize", () => {
  const flat = PROB_ONE / policy.lotteryOddsOneIn;
  const rake = 225n * 10n ** 12n; // a 5,000-credit quiet round's rake in wei
  const c = (rake * 4_000n * policy.powerboardFundingBps) / (BPS * BPS);
  let prev = flat + 1n;
  for (let e = 12; e <= 27; e += 1) {
    const P = 10n ** BigInt(e);
    const t = hitThresholdE18(c, P, policy);
    assert.ok(t <= flat, "never better than the flat ceiling");
    assert.ok(t <= prev, "non-increasing in the prize");
    prev = t;
    const { winnerPaid } = carvePrize(P, policy);
    assert.ok(t * winnerPaid <= (c * PROB_ONE * BPS) / policy.lotteryKappaBps + winnerPaid, "E[payout] <= c/kappa (+1 wei rounding)");
    assert.ok(t * winnerPaid < rake * PROB_ONE, `attacker EV >= 0 at P=1e${e}`);
  }
  assert.equal(hitThresholdE18(c, 0n, policy), flat, "no prize: flat ceiling (recordRound skips the draw anyway)");
  assert.equal(hitThresholdE18(c, 1n, policy), flat, "tiny prize: the flat branch binds");
});

test("a natural hit pays exactly W to the round and re-seeds exactly S; a miss leaves the pool untouched; no forced hit exists", () => {
  const players = [
    { id: "a", stake: 20n * ETH, targetBps: 15_000n },
    { id: "b", stake: 20n * ETH, targetBps: 20_000n },
  ];
  let state = initialSimulationState(policy);
  state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none", externalLotteryFunding: ETH }).state;
  const prize = state.lottery.committedPrize;
  assert.ok(prize > 0n);
  // Miss: a sample at PROB_ONE - 1 is above any threshold.
  const miss = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none", lotteryDrawE18: PROB_ONE - 1n });
  assert.equal(miss.lotteryEvent, "miss");
  assert.equal(miss.lotteryDraw?.natural, false);
  assert.equal(miss.lotteryDraw?.forced, false);
  assert.ok(miss.state.lottery.pool > state.lottery.pool, "the miss round's contribution still grew the pool");
  assert.equal(miss.state.lottery.committedPrize, miss.state.lottery.pool);
  // Natural hit: sample 0 is below every positive threshold.
  const hit = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none", lotteryDrawE18: 0n });
  assert.equal(hit.lotteryEvent, "hit");
  assert.equal(hit.lotteryDraw?.natural, true);
  const { winnerPaid, seeded } = carvePrize(prize, policy);
  assert.equal(hit.lotteryDraw?.winnerPaid, winnerPaid);
  assert.equal(hit.lotteryDraw?.seeded, seeded);
  assert.equal(hit.state.totals.lotteryWinnerPayouts, winnerPaid);
  assert.equal(hit.state.totals.lotterySeeded, seeded);
  const contributionNet = hit.state.lottery.pool - seeded;
  assert.ok(contributionNet > 0n, "the hit round's own contribution joins the NEXT board");
  assert.equal(hit.state.lottery.hits, 1n);
  assert.equal(hit.state.lottery.draws, 1n);
  assertConserved(hit.state, "hit");
  // A host-forced laboratory outcome is flagged, never silent.
  const forced = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "hit", lotteryDrawE18: PROB_ONE - 1n });
  assert.equal(forced.lotteryEvent, "hit");
  assert.equal(forced.lotteryDraw?.forced, true);
  assert.equal(forced.lotteryDraw?.natural, false);
  // Without a sample there is no natural hit (counts as a miss).
  const noSample = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none" });
  assert.equal(noSample.lotteryEvent, "miss");
  assert.equal(noSample.lotteryDraw?.natural, null);
});

test("the prize is a strict submartingale: under natural draws the pool grows in expectation every round and never needs forcing", () => {
  const random = seededSimulationRandom(0x2026_09_05n);
  const players = [
    { id: "a", stake: 2n * ETH, targetBps: 15_000n },
    { id: "b", stake: 2n * ETH, targetBps: 20_000n },
  ];
  let state = initialSimulationState(policy);
  let hits = 0;
  let maxDrawsBetweenHits = 0n;
  let lastHitDraw = 0n;
  for (let i = 0; i < 3_000; i += 1) {
    // A deterministic sweep of the unit interval (64 evenly spaced samples,
    // jittered): every sample below the round's threshold is a natural hit.
    const sample = (BigInt(i % 64) * PROB_ONE) / 64n + (random() % (PROB_ONE / 64n));
    const result = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none", lotteryDrawE18: sample });
    if (result.lotteryEvent === "hit") {
      hits += 1;
      if (result.state.lottery.draws - lastHitDraw > maxDrawsBetweenHits) maxDrawsBetweenHits = result.state.lottery.draws - lastHitDraw;
      lastHitDraw = result.state.lottery.draws;
    }
    state = result.state;
    assertConserved(state, `iteration ${i}`);
  }
  assert.ok(hits > 0, "natural hits happen without any forcing mechanism");
  assert.ok(state.lottery.highWaterPrize > 0n);
  assert.ok(state.lottery.pool >= state.lottery.committedPrize);
});

test("ten thousand deterministic multiplayer iterations preserve all monotonic invariants", () => {
  const random = seededSimulationRandom(0x20260827n);
  let state = initialSimulationState(policy);
  let priorPrincipal = 0n;
  let priorHighWater = 0n;
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const count = 2 + Number(random() % 20n);
    const players = Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      stake: policy.minimumStake + (random() % (ETH / 10n)),
      targetBps: 10_100n + (random() % 90_000n),
    }));
    state = simulateIteration(state, policy, {
      players,
      crashBps: 10_000n + (random() % 100_000n),
      lotteryOutcome: "none",
      lotteryDrawE18: (random() * random()) % PROB_ONE,
    }).state;
    assert.ok(state.protectedPrincipal >= priorPrincipal);
    assert.ok(state.lottery.highWaterPrize >= priorHighWater);
    assert.ok(state.lottery.committedPrize <= state.lottery.pool);
    assert.ok(accountedAssets(state) >= 0n);
    assertConserved(state, `iteration ${iteration}`);
    priorPrincipal = state.protectedPrincipal;
    priorHighWater = state.lottery.highWaterPrize;
  }
  assert.equal(state.iteration, 10_000n);
  assert.ok(state.totals.freshWagers > 0n);
  assert.doesNotThrow(() => JSON.stringify(serializeSimulationState(state)));
});
