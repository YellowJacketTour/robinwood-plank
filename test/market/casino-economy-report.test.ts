import assert from "node:assert/strict";
import test from "node:test";
import { BPS, minimumLotteryGross } from "../../lib/casino/economics.ts";
import {
  activationPace,
  creditsToEth,
  creditsToUsd,
  lotteryActivationQuote,
  lotteryShareOfPotPpm,
  seedShareBps,
  vaultGrowthBps,
  vaultShareOfPotPpm,
} from "../../lib/casino/economy-report.ts";
import {
  initialSimulationState,
  nextCycleBase,
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

function assertQuoteMatchesKernel(state: SimulationState, label: string) {
  const quote = lotteryActivationQuote(state, policy);
  assert.equal(quote.readyForDraw, state.lottery.readyForDraw);
  assert.equal(
    quote.remaining === 0n && !quote.awaitingSeal,
    state.lottery.readyForDraw,
    `${label}: remaining-to-activation must be 0 exactly when the kernel's readyForDraw gate is open (remaining=${quote.remaining} awaiting=${quote.awaitingSeal})`,
  );
  assert.equal(quote.requiredReserve, minimumLotteryGross(nextCycleBase(state.lottery.cycleBase, policy), policy.lotteryFounderFeeBps));
  if (state.lottery.awaitingSeal) {
    assert.equal(quote.requiredGross, minimumLotteryGross(state.lottery.nextPrizeTarget, policy.lotteryFounderFeeBps));
    assert.equal(quote.prizeNow, state.lottery.rollover + state.lottery.pendingFunding);
  } else {
    assert.equal(quote.prizeNow, state.lottery.netPrize);
    assert.equal(quote.target, state.lottery.netPrize);
  }
  assert.ok(quote.fundedBps >= 0n && quote.fundedBps <= BPS);
  assert.equal(quote.fundedTotal + quote.remaining, quote.requiredTotal);
}

test("remaining-to-activation equals the kernel's readyForDraw gate exactly (funding, seal, reserve, miss, hit)", () => {
  const initial = initialSimulationState(policy);
  const genesisQuote = lotteryActivationQuote(initial, policy);
  assert.equal(genesisQuote.requiredGross, 55_555n, "minimumLotteryGross(50,000, 10%)");
  assert.equal(genesisQuote.requiredReserve, minimumLotteryGross(100_000n, 1_000n));
  assert.equal(genesisQuote.remaining, 55_555n + 111_111n);
  assert.equal(genesisQuote.status, "funding");
  assertQuoteMatchesKernel(initial, "genesis");

  let state = initial;
  const random = seededSimulationRandom(7n);
  const outcomes = ["none", "miss", "hit"] as const;
  let sawReady = false, sawHit = false, sawMiss = false;
  for (let i = 0; i < 400; i += 1) {
    const external = i % 7 === 3 ? 20_000n + (random() % 60_000n) : 0n;
    const outcome = outcomes[Number(random() % 3n)];
    const before = lotteryActivationQuote(state, policy);
    const result = simulateIteration(state, policy, {
      players: twoPlayers, crashBps: 15_000n + (random() % 30_000n), lotteryOutcome: outcome, externalLotteryFunding: external,
    });
    state = result.state;
    assertQuoteMatchesKernel(state, `iteration ${i} (${result.lotteryEvent})`);
    if (result.lotteryEvent === "hit") sawHit = true;
    if (result.lotteryEvent === "miss") sawMiss = true;
    if (state.lottery.readyForDraw) sawReady = true;
    // Funding only ever shrinks the remaining figure unless a draw resolved.
    if (result.lotteryEvent === "funding" || result.lotteryEvent === "sealed") {
      assert.ok(lotteryActivationQuote(state, policy).remaining <= before.remaining, `iteration ${i}: remaining grew without a draw`);
    }
  }
  assert.ok(sawReady && sawHit && sawMiss, `walk must exercise ready/hit/miss (ready=${sawReady} hit=${sawHit} miss=${sawMiss})`);
});

test("reserve surplus never counts toward the prize bucket", () => {
  const state = initialSimulationState(policy);
  state.lottery.resetReserve = 500_000n; // far above the 111,111 reserve requirement
  state.lottery.pendingFunding = 40_000n; // short of the 55,555 prize gross
  const quote = lotteryActivationQuote(state, policy);
  assert.equal(quote.reserveShort, 0n);
  assert.equal(quote.prizeShort, 15_555n);
  assert.equal(quote.remaining, 15_555n, "prize shortfall is not netted against the reserve surplus");
});

test("activation pace: ceil(remaining / average of the last 10 rounds) at the table cadence", () => {
  const pace = activationPace(166_666n, [234n, 234n, 234n], 30n);
  assert.equal(pace.averageFundingPerRound, 234n);
  assert.equal(pace.roundsSampled, 3);
  assert.equal(pace.roundsToActivation, 713n); // ceil(166666 / 234)
  assert.equal(pace.secondsToActivation, 713n * 30n);
  const eleven = Array.from({ length: 11 }, (_, i) => (i === 10 ? 1_000_000n : 100n));
  assert.equal(activationPace(1_000n, eleven, 30n).averageFundingPerRound, 100n, "only the newest 10 are sampled");
  assert.equal(activationPace(1_000n, [], 30n).roundsToActivation, null);
  assert.equal(activationPace(0n, [], 30n).roundsToActivation, 0n);
});
