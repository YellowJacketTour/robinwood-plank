import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { accountedAssets, carvePrize, initialSimulationState, PROB_ONE, simulateIteration } from "../../lib/casino/simulation";
import {
  bettingRoundId,
  canonicalJson, crashDurationMs, DEFAULT_PLAYTEST_POLICY, effectiveSettlementTarget, injectSimulationState, legacyPlaytestPrizeProfile,
  migrateLegacyLotteryState, multiplierAt, newcomerSeatPlan, parsePolicy, parseSimulationState, PLAYTEST_POWERBOARD_BALLS, playtestRulesHash,
  serializeBigInts, simulationCrashBps, powerboardRoundDraw,
} from "../../lib/playtest-room-core";

test("a genuine newcomer receives exactly one affordable welcome-flight seat", () => {
  assert.deepEqual(newcomerSeatPlan(50_000n, 10_000n), {
    stake: 10_000n, targetBps: 20_000n, autoLockEnabled: false,
  });
  assert.equal(newcomerSeatPlan(9_999n, 10_000n), null);
  assert.equal(newcomerSeatPlan(50_000n, 0n), null);
});

test("an unexecuted manual target can never become a retroactive winning lock", () => {
  assert.equal(effectiveSettlementTarget(38_000n, 20_000n, null, false), 38_001n);
  assert.equal(effectiveSettlementTarget(38_000n, 20_000n, null, true), 20_000n);
  assert.equal(effectiveSettlementTarget(38_000n, 20_000n, 17_250n, false), 17_250n);
  assert.equal(effectiveSettlementTarget(38_000n, 20_000n, 17_250n, true), 17_250n);
  assert.equal(effectiveSettlementTarget(38_000n, 20_000n, 25_000n, true), 20_000n);
});

test("a multiplayer lobby advances once and keeps every commitment in one round", () => {
  assert.equal(bettingRoundId("lobby", 0n), 1n, "the first-ever lobby opens round one");
  assert.equal(bettingRoundId("settled", 16n), 17n, "the first post-settlement bet advances once");
  assert.equal(bettingRoundId("lobby", 17n), 17n, "host and guests join the already-open lobby");
  assert.throws(() => bettingRoundId("running", 17n), /closed/);
});

test("every committed reveal produces one bounded deterministic uniform sample and presentation ball", () => {
  const reveal = "ab".repeat(32);
  const first = powerboardRoundDraw(reveal);
  assert.deepEqual(first, powerboardRoundDraw(reveal));
  assert.ok(first.sampleE18 >= 0n && first.sampleE18 < PROB_ONE);
  assert.ok(first.drawnNumber >= 1 && first.drawnNumber <= PLAYTEST_POWERBOARD_BALLS);
  assert.equal(first.drawnNumber, Number((first.sampleE18 * BigInt(PLAYTEST_POWERBOARD_BALLS)) / PROB_ONE) + 1, "the ball is the sample's sixteenth");
  assert.equal(first.winningNumber, 1);
  assert.throws(() => powerboardRoundDraw("nope"), /invalid reveal/);
});

test("room rules hash is canonical and stable across key order", () => {
  const a = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
  const b = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
  assert.match(playtestRulesHash(DEFAULT_PLAYTEST_POLICY), /^[0-9a-f]{64}$/);
});

test("admin scenario injection changes only allowlisted laboratory state; an injected pool is the next prize", () => {
  const initial = initialSimulationState(DEFAULT_PLAYTEST_POLICY);
  const injected = injectSimulationState(initial, {
    protectedPrincipal: "5000000",
    "lottery.pool": "900000",
    "lottery.highWaterPrize": "1",
    "totals.burned": "42000",
  });
  assert.equal(injected.protectedPrincipal, 5_000_000n);
  assert.equal(injected.lottery.pool, 900_000n);
  assert.equal(injected.lottery.committedPrize, 900_000n, "a funded board is immediately drawable");
  assert.equal(injected.lottery.highWaterPrize, 900_000n);
  assert.equal(injected.totals.burned, 42_000n);
  assert.equal(initial.protectedPrincipal, 0n, "the authoritative prior snapshot is not mutated");
  assert.throws(() => injectSimulationState(initial, { iteration: "999" }), /cannot be injected/);
  assert.throws(() => injectSimulationState(initial, { "lottery.awaitingSeal": false }), /cannot be injected/);
  assert.throws(() => injectSimulationState(initial, { "lottery.pool": "10", "lottery.committedPrize": "11" }), /cannot exceed the pool/);
});

test("policy and simulation state survive JSON without losing integer precision", () => {
  const policyJson = serializeBigInts(DEFAULT_PLAYTEST_POLICY);
  assert.deepEqual(parsePolicy(policyJson), DEFAULT_PLAYTEST_POLICY);
  const state = initialSimulationState(DEFAULT_PLAYTEST_POLICY);
  state.protectedPrincipal = 2n ** 200n;
  assert.deepEqual(parseSimulationState(serializeBigInts(state)), state);
});

test("public policy starts at a conservative one-dollar-reference floor", () => {
  assert.equal(DEFAULT_PLAYTEST_POLICY.minimumStake, 500n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.rakeBps, 450n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.rakeFloorBps, 250n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.rakeStepBps, 25n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.rakeVolumeStep, 25_000_000n);
});

// ── The lottery law (2026-09-05): the laboratory deploys the SAME parameters
// as contracts/PlankLottery.sol (RESEARCH-game-theory-lottery-seed-resolution).
test("playtest lottery law is pinned to the contract parameters; no forced hit exists in the policy", () => {
  assert.equal(DEFAULT_PLAYTEST_POLICY.powerboardFundingBps, 6_500n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryFounderFeeBps, 1_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryOddsOneIn, 16n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryKappaBps, 20_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.carveMinBps, 1_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.carveMaxBps, 3_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.carveHalfSaturation, 250_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.protectedPrincipalBps, 5_000n);
  for (const key of Object.keys(DEFAULT_PLAYTEST_POLICY)) assert.doesNotMatch(key, /mustHit|consolation|InitialBase|BaseGrowth|MinimumIncrease/i);
  assert.equal(legacyPlaytestPrizeProfile(serializeBigInts(DEFAULT_PLAYTEST_POLICY)), null, "the live default is current");
  assert.equal(legacyPlaytestPrizeProfile({ ...serializeBigInts(DEFAULT_PLAYTEST_POLICY) as object, lotteryInitialBase: "50000" }), "pre-actuarial", "a stored legacy key marks the room for migration");
  const missing = serializeBigInts(DEFAULT_PLAYTEST_POLICY) as Record<string, unknown>;
  delete missing.lotteryKappaBps;
  assert.equal(legacyPlaytestPrizeProfile(missing), "pre-actuarial", "a stored policy without the current law is migrated");
  // Legacy keys are dropped and current keys defaulted when parsing.
  const parsed = parsePolicy({ ...missing, lotteryInitialBase: "50000", consolation: "0" });
  assert.deepEqual(parsed, DEFAULT_PLAYTEST_POLICY);
});

test("genesis funding: 65% of the community leg reaches the prize net of the founder fee; the first draw prices the round by its own contribution", () => {
  const policy = DEFAULT_PLAYTEST_POLICY;
  const players = [{ id: "a", stake: 10_000n, targetBps: 15_000n }, { id: "b", stake: 10_000n, targetBps: 15_000n }];
  const round = (state: ReturnType<typeof initialSimulationState>, sample: bigint) => simulateIteration(state, policy, { players, crashBps: 20_000n, lotteryOutcome: "none", lotteryDrawE18: sample });
  const first = round(initialSimulationState(policy), 0n);
  // 20,000 pot × 4.50% = 900 rake → community 621 (69%, revised 2026-09-05
  // from 40% -- SPEC-monotonic-vault-positive-sum §4) → 65% = 403 to the
  // prize (fee 40 → 363 banked); the retained 218 splits 50/50 principal / buffer.
  assert.equal(first.state.totals.communityFunded, 621n);
  assert.equal(first.state.totals.powerboardFunded, 403n);
  assert.equal(first.state.lottery.pool, 363n);
  assert.equal(first.state.lottery.committedPrize, 363n);
  assert.equal(first.state.protectedPrincipal, 109n);
  assert.equal(first.state.emissionBuffer, 109n);
  assert.equal(first.lotteryEvent, "funding", "nothing was on the board before the genesis round");
  // Second round: a 363-credit prize is in the flat regime (W tiny) -> 1 in 16; sample 0 hits.
  const second = round(first.state, 0n);
  assert.equal(second.lotteryEvent, "hit");
  assert.equal(second.lotteryDraw?.thresholdE18, PROB_ONE / 16n);
  const { winnerPaid, seeded } = carvePrize(363n, policy);
  assert.equal(second.lotteryDraw?.winnerPaid, winnerPaid);
  assert.equal(second.state.lottery.pool, seeded + 363n, "next board = carve seed + this round's own net contribution");
  assert.equal(second.state.totals.lotteryWinnerPayouts, winnerPaid);
  // A miss (sample at the top of the range) leaves the pool growing.
  const third = round(second.state, PROB_ONE - 1n);
  assert.equal(third.lotteryEvent, "miss");
  assert.equal(third.state.lottery.pool, second.state.lottery.pool + 363n);
});

test("pre-actuarial snapshots migrate to the pool model conserving accounted assets exactly, and stay replayable", () => {
  const legacy = {
    iteration: "40", protectedPrincipal: "999", emissionBuffer: "500",
    lottery: {
      cycle: "1", epoch: "3", cycleBase: "100000", netPrize: "50000", pendingFunding: "4321", resetReserve: "20000",
      rollover: "700", nextPrizeTarget: "50000", awaitingSeal: false, readyForDraw: false, highWaterPrize: "50000",
    },
    totals: {
      freshWagers: "1", grossRake: "1", keeperRewards: "0", burned: "0", communityFunded: "0", powerboardFunded: "0", crashFounderRake: "0",
      lotteryGrossConstituted: "1000", lotteryFounderFees: "100", lotteryFounderFeesOnRollover: "5", playerCrashPayouts: "0",
      lotteryWinnerPayouts: "0", consolationPayouts: "0", vaultRemainders: "0", externalLotteryFunding: "0", flightSeeded: "0",
    },
  };
  const legacyAccounted = 999n + 500n + 50_000n + 4_321n + 20_000n + 700n;
  const migrated = parseSimulationState(legacy);
  // gross buckets 24,321 pay the 10% fee they had not yet paid (2,432); everything already net joins as is.
  assert.equal(migrated.lottery.pool, 50_000n + 700n + 24_321n - 2_432n);
  assert.equal(migrated.lottery.committedPrize, migrated.lottery.pool, "the whole board is immediately drawable");
  assert.equal(migrated.lottery.hits, 1n, "cycle count carries over as hits");
  assert.equal(migrated.lottery.draws, 0n);
  assert.equal(migrated.lottery.highWaterPrize, migrated.lottery.pool);
  assert.equal(migrated.totals.lotteryFounderFees, 100n + 2_432n);
  assert.equal(migrated.totals.lotteryGrossConstituted, 1_000n + 24_321n);
  assert.equal(accountedAssets(migrated) + 2_432n, legacyAccounted, "conserved: the only difference is the fee now booked");
  assert.deepEqual(parseSimulationState(serializeBigInts(migrated)), migrated, "idempotent: a migrated snapshot parses unchanged");
  const plain = JSON.parse(JSON.stringify(legacy));
  migrateLegacyLotteryState(plain);
  migrateLegacyLotteryState(plain);
  assert.equal(plain.lottery.pool, migrated.lottery.pool.toString());
  // The migrated state settles under the current law.
  const players = [{ id: "a", stake: 10_000n, targetBps: 15_000n }, { id: "b", stake: 10_000n, targetBps: 15_000n }];
  const next = simulateIteration(migrated, DEFAULT_PLAYTEST_POLICY, { players, crashBps: 20_000n, lotteryOutcome: "none", lotteryDrawE18: PROB_ONE - 1n });
  assert.equal(next.lotteryEvent, "miss");
  assert.equal(next.lotteryDraw?.prize, migrated.lottery.pool);
});

test("pre-provenance snapshots remain replayable", () => {
  const legacy = serializeBigInts(initialSimulationState(DEFAULT_PLAYTEST_POLICY)) as Record<string, unknown>;
  delete (legacy.totals as Record<string, unknown>).powerboardFunded;
  delete (legacy.totals as Record<string, unknown>).lotterySeeded;
  assert.equal(parseSimulationState(legacy).totals.powerboardFunded, 0n);
  assert.equal(parseSimulationState(legacy).totals.lotterySeeded, 0n);
});

test("laboratory crash fixture is deterministic, bounded, and committed separately", () => {
  const reveal = "f".repeat(64);
  const crash = simulationCrashBps(reveal);
  assert.equal(crash, simulationCrashBps(reveal));
  assert.ok(crash >= 10_000n && crash <= 100_000_000n);
  const maximum = simulationCrashBps(`${"0".repeat(60)}270f`);
  assert.ok(maximum > 1_000_000n, "the laboratory preserves a genuine tail beyond 100x");
  assert.equal(maximum, 100_000_000n);
  assert.throws(() => simulationCrashBps("not-a-reveal"));
});

test("authoritative display curve is monotonic and reaches crash on its deadline", () => {
  const start = 1_000_000;
  const crash = 250_000n;
  const duration = crashDurationMs(crash);
  assert.equal(multiplierAt(start, start), 10_000n);
  assert.ok(multiplierAt(start, start + duration / 2) > 10_000n);
  assert.ok(multiplierAt(start, start + duration) >= crash);
  const enormous = 100_000_000n;
  const enormousDuration = crashDurationMs(enormous);
  assert.ok(enormousDuration > 40_000 && enormousDuration < 45_000);
  assert.ok(multiplierAt(start, start + enormousDuration - 1) < enormous);
  assert.ok(multiplierAt(start, start + enormousDuration) >= enormous);
});

// Authoritative fixture pinning the draw derivation. If the
// sha256("<reveal>:powerboard:number") mapping ever changes, replayed/settled
// rounds would silently present a DIFFERENT sample than the one committed --
// this literal fixture makes that impossible to miss.
test("the committed-reveal -> displayed sample mapping is pinned by fixture", () => {
  const draw = powerboardRoundDraw("ab".repeat(32));
  const expected = BigInt(`0x${createHash("sha256").update(`${"ab".repeat(32)}:powerboard:number`).digest("hex")}`) % PROB_ONE;
  assert.equal(draw.sampleE18, expected);
  assert.equal(draw.drawnNumber, Number((expected * 16n) / PROB_ONE) + 1);
  assert.equal(draw.balls, 16);
});
