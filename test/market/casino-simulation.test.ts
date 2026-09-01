import assert from "node:assert/strict";
import test from "node:test";
import {
  accountedAssets,
  evolutionQuote,
  initialSimulationState,
  seededSimulationRandom,
  serializeSimulationState,
  simulateIteration,
  type SimulationPolicy,
} from "../../lib/casino/simulation.ts";

const ETH = 10n ** 18n;
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
  lotteryInitialBase: ETH / 100n,
  lotteryMinimumIncrease: ETH / 10_000n,
  lotteryBaseGrowthBps: 100n,
  lotteryMinimumBaseStep: ETH / 10_000n,
  consolation: 0n,
  allocationRule: "pfss",
  minimumPlayers: 2,
  minimumStake: ETH / 1_000n,
};

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
});

test("ratified split, principal, emissions, and payouts conserve a qualified round", () => {
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
  assert.ok(result.state.lottery.pendingFunding > 0n, "every qualified game funds Powerboard from community rake");
  const playerNetIn = result.state.totals.freshWagers
    - result.state.totals.burned
    - result.state.totals.crashFounderRake;
  assert.equal(playerNetIn, result.state.totals.playerCrashPayouts + accountedAssets(result.state));
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

test("misses seal only at a strictly larger net prize and charge rollover fee", () => {
  let state = initialSimulationState(policy);
  const players = [
    { id: "a", stake: 10n * ETH, targetBps: 15_000n },
    { id: "b", stake: 10n * ETH, targetBps: 20_000n },
  ];
  for (let index = 0; index < 20 && !state.lottery.readyForDraw; index += 1) {
    state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none" }).state;
  }
  assert.equal(state.lottery.readyForDraw, true);
  const priorPrize = state.lottery.netPrize;
  state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "miss" }).state;
  assert.equal(state.lottery.awaitingSeal, true);
  for (let index = 0; index < 20 && state.lottery.awaitingSeal; index += 1) {
    state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none" }).state;
  }
  assert.ok(state.lottery.netPrize >= priorPrize + policy.lotteryMinimumIncrease);
  assert.ok(state.totals.lotteryFounderFeesOnRollover > 0n);
});

test("a hit pays the displayed prize and restarts at a strictly higher covered base", () => {
  let state = initialSimulationState(policy);
  const players = [
    { id: "a", stake: 20n * ETH, targetBps: 15_000n },
    { id: "b", stake: 20n * ETH, targetBps: 20_000n },
  ];
  for (let index = 0; index < 20 && !state.lottery.readyForDraw; index += 1) {
    state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "none" }).state;
  }
  const prize = state.lottery.netPrize;
  const base = state.lottery.cycleBase;
  const winnerBefore = state.totals.lotteryWinnerPayouts;
  state = simulateIteration(state, policy, { players, crashBps: 25_000n, lotteryOutcome: "hit" }).state;
  assert.equal(state.totals.lotteryWinnerPayouts - winnerBefore, prize);
  assert.ok(state.lottery.cycleBase > base);
  assert.ok(state.lottery.netPrize >= state.lottery.cycleBase);
});

test("ten thousand deterministic multiplayer iterations preserve all monotonic invariants", () => {
  const random = seededSimulationRandom(0x20260827n);
  let state = initialSimulationState(policy);
  let priorPrincipal = 0n;
  let priorBase = policy.lotteryInitialBase;
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    const count = 2 + Number(random() % 20n);
    const players = Array.from({ length: count }, (_, index) => ({
      id: `p${index}`,
      stake: policy.minimumStake + (random() % (ETH / 10n)),
      targetBps: 10_100n + (random() % 90_000n),
    }));
    const outcome = state.lottery.readyForDraw
      ? (random() % 97n === 0n ? "hit" : "miss")
      : "none";
    state = simulateIteration(state, policy, {
      players,
      crashBps: 10_000n + (random() % 100_000n),
      lotteryOutcome: outcome,
    }).state;
    assert.ok(state.protectedPrincipal >= priorPrincipal);
    assert.ok(state.lottery.cycleBase >= priorBase);
    assert.ok(accountedAssets(state) >= 0n);
    assert.equal(
      state.totals.freshWagers + state.totals.externalLotteryFunding,
      state.totals.burned
        + state.totals.keeperRewards
        + state.totals.crashFounderRake
        + state.totals.lotteryFounderFees
        + state.totals.playerCrashPayouts
        + state.totals.lotteryWinnerPayouts
        + state.totals.consolationPayouts
        + accountedAssets(state),
      `global conservation at iteration ${iteration}`,
    );
    priorPrincipal = state.protectedPrincipal;
    priorBase = state.lottery.cycleBase;
  }
  assert.equal(state.iteration, 10_000n);
  assert.ok(state.totals.freshWagers > 0n);
  assert.doesNotThrow(() => JSON.stringify(serializeSimulationState(state)));
});
