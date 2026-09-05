import assert from "node:assert/strict";
import test from "node:test";
import { BPS } from "../../lib/casino/economics.ts";
import {
  contributionPace,
  creditsToEth,
  creditsToUsd,
  lotteryPrizeQuote,
  lotteryShareOfPotPpm,
  playerRoundOdds,
  seedShareBps,
  vaultGrowthBps,
  vaultShareOfPotPpm,
} from "../../lib/casino/economy-report.ts";
import {
  carvePrize,
  hitThresholdE18,
  initialSimulationState,
  PROB_ONE,
  seededSimulationRandom,
  simulateIteration,
  type SimulationState,
} from "../../lib/casino/simulation.ts";
import { DEFAULT_PLAYTEST_POLICY, parseSimulationState, serializeBigInts } from "../../lib/playtest-room-core.ts";

const policy = DEFAULT_PLAYTEST_POLICY;
const twoPlayers = [
  { id: "a", stake: 10_000n, targetBps: 15_000n },
  { id: "b", stake: 10_000n, targetBps: 15_000n },
];

test("credits convert to ETH exactly at 1 cr = 1e-6 ETH, and to USD only with a quote", () => {
  assert.equal(creditsToEth(10_000n), "0.010");
  assert.equal(creditsToEth(1_000_000n), "1.000");
  assert.equal(creditsToEth(731_000n), "0.731");
  assert.equal(creditsToEth(1n), "0.000001");
  assert.equal(creditsToEth(55_555n), "0.055555");
  assert.equal(creditsToEth(-2_500n), "-0.0025");
  assert.equal(creditsToUsd(1_000_000n, 2_513.56), 2_513.56);
  assert.equal(creditsToUsd(10_000n, 2_513.56)!.toFixed(4), "25.1356");
  assert.equal(creditsToUsd(10_000n, null), null);
  assert.equal(creditsToUsd(10_000n, 0), null);
});

test("vault share of the pot is derived from the policy: 4.5% x 40% x 35% x 50% = 0.315%", () => {
  assert.equal(vaultShareOfPotPpm(policy, policy.rakeBps), 3_150n);
  assert.equal(lotteryShareOfPotPpm(policy, policy.rakeBps), 11_700n);
  // A 2 x 10,000 round: rake 900 -> community 360 -> lottery 234, vault 63.
  const genesis = simulateIteration(initialSimulationState(policy), policy, { players: twoPlayers, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(genesis.state.protectedPrincipal, 20_000n * 3_150n / 1_000_000n);
  assert.equal(genesis.state.totals.powerboardFunded, 20_000n * 11_700n / 1_000_000n);
});

test("vault growth and seed share: genesis has no ratio; later rounds are delta / previous", () => {
  assert.equal(vaultGrowthBps(0n, 63n), null);
  assert.equal(vaultGrowthBps(63n, 63n), BPS);
  assert.equal(vaultGrowthBps(1_000n, 5n), 50n);
  assert.equal(seedShareBps(0n, 0n), 0n);
  assert.equal(seedShareBps(500n, 2_000n), 2_500n);
});

test("the flight seed is exposed per round and accumulates in totals.flightSeeded", () => {
  let state = initialSimulationState(policy);
  const first = simulateIteration(state, policy, { players: twoPlayers, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(first.seed, 0n, "genesis: the seed buffer is still filling");
  state = first.state;
  state = { ...state, emissionBuffer: 4_000n };
  const second = simulateIteration(state, policy, { players: twoPlayers, crashBps: 20_000n, lotteryOutcome: "none" });
  assert.equal(second.seed, 4_000n, "seed = min(buffer, crashSeed)");
  assert.equal(second.state.totals.flightSeeded, 4_000n);
  const revived = parseSimulationState(serializeBigInts(second.state));
  assert.equal(revived.totals.flightSeeded, 4_000n);
  const legacy = serializeBigInts(second.state) as { totals: Record<string, unknown> };
  delete legacy.totals.flightSeeded;
  assert.equal(parseSimulationState(legacy).totals.flightSeeded, 0n, "pre-provenance snapshots default to 0");
});

function assertQuoteMatchesKernel(state: SimulationState, contribution: bigint, label: string) {
  const quote = lotteryPrizeQuote(state, policy, contribution);
  assert.equal(quote.prize, state.lottery.committedPrize, `${label}: prize == committedPrize`);
  assert.equal(quote.pool, state.lottery.pool);
  const carve = carvePrize(state.lottery.committedPrize, policy);
  assert.equal(quote.winnerTake, carve.winnerPaid, `${label}: displayed == redeemable`);
  assert.equal(quote.nextSeed, carve.seeded);
  assert.equal(quote.winnerTake + quote.nextSeed, quote.prize);
  if (state.lottery.committedPrize > 0n) {
    assert.equal(quote.thresholdE18, hitThresholdE18(contribution, state.lottery.committedPrize, policy), `${label}: threshold from the kernel`);
    assert.ok(quote.thresholdE18 <= PROB_ONE / policy.lotteryOddsOneIn);
    assert.equal(quote.status, "active");
    assert.ok(quote.oddsOneIn !== null && quote.oddsOneIn >= policy.lotteryOddsOneIn, "never better than the flat ceiling");
  } else {
    assert.equal(quote.status, "funding");
    assert.equal(quote.thresholdE18, 0n);
    assert.equal(quote.oddsOneIn, null);
  }
}

test("the prize quote mirrors the kernel exactly across a random walk with natural draws (funding, miss, hit)", () => {
  const initial = initialSimulationState(policy);
  const genesis = lotteryPrizeQuote(initial, policy, 234n);
  assert.equal(genesis.status, "funding");
  assert.equal(genesis.prize, 0n);
  assert.equal(genesis.flatOddsOneIn, 16n);
  assert.equal(genesis.kappaBps, 20_000n);
  assertQuoteMatchesKernel(initial, 234n, "genesis");

  let state = initial;
  const random = seededSimulationRandom(7n);
  let sawHit = false, sawMiss = false, sawActuarial = false;
  for (let i = 0; i < 600; i += 1) {
    const external = i % 7 === 3 ? 20_000n + (random() % 60_000n) : 0n;
    const result = simulateIteration(state, policy, {
      players: twoPlayers, crashBps: 15_000n + (random() % 30_000n), lotteryOutcome: "none",
      lotteryDrawE18: (random() * random()) % PROB_ONE, externalLotteryFunding: external,
    });
    state = result.state;
    assertQuoteMatchesKernel(state, 234n, `iteration ${i} (${result.lotteryEvent})`);
    if (result.lotteryEvent === "hit") sawHit = true;
    if (result.lotteryEvent === "miss") sawMiss = true;
    if (lotteryPrizeQuote(state, policy, 234n).regime === "actuarial") sawActuarial = true;
  }
  assert.ok(sawHit && sawMiss && sawActuarial, `walk must exercise hit/miss/actuarial (hit=${sawHit} miss=${sawMiss} actuarial=${sawActuarial})`);
});

test("a 2 x 10,000 table against a 90,000-credit prize is priced in the actuarial regime, exactly as the contract prices it", () => {
  const state = initialSimulationState(policy);
  state.lottery.pool = 90_000n; state.lottery.committedPrize = 90_000n;
  const quote = lotteryPrizeQuote(state, policy, 234n);
  // S(90,000) = floor(90,000 x 0.15294) = 13,764 -> W = 76,236 (integer credits); c = 234; kappa = 2 -> p = 234 / 152,472
  assert.equal(quote.winnerTake, 76_236n);
  assert.equal(quote.nextSeed, 13_764n);
  assert.equal(quote.thresholdE18, (234n * PROB_ONE * BPS) / (20_000n * 76_236n));
  assert.equal(quote.regime, "actuarial");
  assert.equal(quote.oddsOneIn, 652n, "ceil(152,472 / 234)");
  // Expected pool growth per such round: 234 net of the 10% fee minus E[payout] = 211 - 116 = 95 credits.
  assert.equal(quote.expectedGrowthPerRound, 234n - 23n - (quote.thresholdE18 * quote.winnerTake) / PROB_ONE);
  assert.equal(quote.expectedGrowthPerRound, 95n);
  assert.ok(quote.expectedGrowthPerRound > 0n, "strict submartingale");
  // A player's own odds: half the round's stake -> half the round's chance.
  const mine = playerRoundOdds(quote.thresholdE18, 10_000n, 20_000n, quote.winnerTake);
  assert.equal(mine.sharePpm, 500_000n);
  assert.equal(mine.oddsOneIn, 1_304n);
  assert.equal(mine.probabilityWeightedPrize, ((quote.thresholdE18 * 10_000n) / 20_000n * quote.winnerTake) / PROB_ONE);
  assert.deepEqual(playerRoundOdds(quote.thresholdE18, 0n, 20_000n, quote.winnerTake), { sharePpm: 0n, oddsOneIn: null, probabilityWeightedPrize: 0n });
  assert.throws(() => playerRoundOdds(quote.thresholdE18, 30_000n, 20_000n, 1n), /invalid/);
});

test("contribution pace: average of the newest 10 rounds and the expected rounds to a hit at the quoted threshold", () => {
  const pace = contributionPace([234n, 234n, 234n], PROB_ONE / 652n, 30n);
  assert.equal(pace.averageContributionPerRound, 234n);
  assert.equal(pace.roundsSampled, 3);
  assert.equal(pace.expectedRoundsToHit, 653n);
  assert.equal(pace.expectedSecondsToHit, 653n * 30n);
  const eleven = Array.from({ length: 11 }, (_, i) => (i === 10 ? 1_000_000n : 100n));
  assert.equal(contributionPace(eleven, PROB_ONE / 16n, 30n).averageContributionPerRound, 100n, "only the newest 10 are sampled");
  assert.equal(contributionPace([], PROB_ONE / 16n, 30n).expectedRoundsToHit, null);
  assert.equal(contributionPace([234n], 0n, 30n).expectedRoundsToHit, null);
});
