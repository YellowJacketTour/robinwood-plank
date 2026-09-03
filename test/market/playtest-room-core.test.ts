import assert from "node:assert/strict";
import test from "node:test";
import { minimumLotteryGross } from "../../lib/casino/economics";
import { accountedAssets, initialSimulationState, simulateIteration } from "../../lib/casino/simulation";
import {
  bettingRoundId,
  canonicalJson, crashDurationMs, DEFAULT_PLAYTEST_POLICY, effectiveSettlementTarget, injectSimulationState, legacyPlaytestPrizeProfile, multiplierAt,
  newcomerSeatPlan, parsePolicy, parseSimulationState, PLAYTEST_PRIZE_PROFILES, playtestRulesHash, rebasePlaytestLotteryTarget, serializeBigInts,
  simulationCrashBps, powerboardRoundDraw, powerboardVoucherQuote,
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

test("every committed reveal produces one bounded deterministic Powerboard number", () => {
  const reveal = "ab".repeat(32);
  const first = powerboardRoundDraw(reveal);
  assert.deepEqual(first, powerboardRoundDraw(reveal));
  assert.ok(first.drawnNumber >= 1 && first.drawnNumber <= first.oddsOneIn);
  assert.equal(first.rawHit, first.drawnNumber === first.winningNumber);
});

test("Powerboard voucher quote exposes exact two-stage odds and is Sybil invariant", () => {
  const whole = powerboardVoucherQuote(25_000n, 100_000n, 1_600_000n, 16);
  assert.deepEqual(whole, {
    conditionalSharePpm: 250_000n,
    combinedOddsOneInCeil: 64n,
    probabilityWeightedPrize: 25_000n,
  });
  const splitA = powerboardVoucherQuote(10_000n, 100_000n, 1_600_000n, 16);
  const splitB = powerboardVoucherQuote(15_000n, 100_000n, 1_600_000n, 16);
  assert.equal(splitA.conditionalSharePpm + splitB.conditionalSharePpm, whole.conditionalSharePpm);
  assert.equal(splitA.probabilityWeightedPrize + splitB.probabilityWeightedPrize, whole.probabilityWeightedPrize);
  assert.throws(() => powerboardVoucherQuote(100_001n, 100_000n, 1n), /invalid/);
});

test("room rules hash is canonical and stable across key order", () => {
  const a = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
  const b = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
  assert.match(playtestRulesHash(DEFAULT_PLAYTEST_POLICY), /^[0-9a-f]{64}$/);
});

test("admin scenario injection changes only allowlisted laboratory state", () => {
  const initial = initialSimulationState(DEFAULT_PLAYTEST_POLICY);
  const injected = injectSimulationState(initial, {
    protectedPrincipal: "5000000",
    "lottery.netPrize": "900000",
    "lottery.highWaterPrize": "1",
    "lottery.awaitingSeal": false,
    "lottery.readyForDraw": true,
    "totals.burned": "42000",
  });
  assert.equal(injected.protectedPrincipal, 5_000_000n);
  assert.equal(injected.lottery.netPrize, 900_000n);
  assert.equal(injected.lottery.highWaterPrize, 900_000n);
  assert.equal(injected.lottery.readyForDraw, true);
  assert.equal(injected.totals.burned, 42_000n);
  assert.equal(initial.protectedPrincipal, 0n, "the authoritative prior snapshot is not mutated");
  assert.throws(() => injectSimulationState(initial, { iteration: "999" }), /cannot be injected/);
  assert.throws(() => injectSimulationState(initial, { "lottery.awaitingSeal": false, "lottery.readyForDraw": true }), /positive prize/);
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

// ── Playtest test-credit prize profile (owner decision 2026-09-03) ──
// RATIFICATION-ccs2l-2026-09-02.md "Playtest test-credit profile". Only the
// laboratory default changes; rake, the 40/40/20 split, the founder fee and
// the ratchet steps are the ratified values and stay pinned here.
test("playtest test-credit prize profile is pinned; ratified economics untouched", () => {
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryInitialBase, 50_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.powerboardFundingBps, 6_500n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.rakeBps, 450n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryFounderFeeBps, 1_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryMinimumIncrease, 50_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryBaseGrowthBps, 500n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.lotteryMinimumBaseStep, 50_000n);
  assert.equal(DEFAULT_PLAYTEST_POLICY.protectedPrincipalBps, 5_000n);
  assert.equal(legacyPlaytestPrizeProfile(DEFAULT_PLAYTEST_POLICY), null, "the live default is not a legacy tuple");
  assert.equal(legacyPlaytestPrizeProfile({ ...DEFAULT_PLAYTEST_POLICY, ...PLAYTEST_PRIZE_PROFILES.v2 }), "v2");
  assert.equal(legacyPlaytestPrizeProfile({ ...DEFAULT_PLAYTEST_POLICY, ...PLAYTEST_PRIZE_PROFILES.v1 }), "v1");
  assert.equal(legacyPlaytestPrizeProfile({ ...DEFAULT_PLAYTEST_POLICY, lotteryInitialBase: 250_000n }), null, "bespoke host edits are never rewritten");
});

test("funded gate arms at the 50k base grossed up by the founder fee; 35% of the community leg compounds the vault", () => {
  const policy = DEFAULT_PLAYTEST_POLICY;
  const players = [{ id: "a", stake: 10_000n, targetBps: 15_000n }, { id: "b", stake: 10_000n, targetBps: 15_000n }];
  const round = (state: ReturnType<typeof initialSimulationState>) => simulateIteration(state, policy, { players, crashBps: 20_000n, lotteryOutcome: "none" });
  const first = round(initialSimulationState(policy));
  // 20,000 pot × 4.50% = 900 rake → community 360 → 65% = 234 to the prize;
  // the retained 126 splits 50/50 protected principal / emission buffer.
  assert.equal(first.state.totals.communityFunded, 360n);
  assert.equal(first.state.lottery.pendingFunding, 234n);
  assert.equal(first.state.totals.powerboardFunded, 234n);
  assert.equal(first.state.protectedPrincipal, 63n);
  assert.equal(first.state.emissionBuffer, 63n);
  const requiredGross = minimumLotteryGross(policy.lotteryInitialBase, policy.lotteryFounderFeeBps);
  assert.equal(requiredGross, 55_555n, "50,000 net ÷ (1 − 10% founder fee), integer-exact");
  const resetGross = minimumLotteryGross(policy.lotteryInitialBase + policy.lotteryMinimumBaseStep, policy.lotteryFounderFeeBps);
  assert.equal(resetGross, 111_111n, "reset reserve covers the ratcheted 100,000 base grossed up");
  let state = first.state; let rounds = 1n;
  while (state.lottery.awaitingSeal) { state = round(state).state; rounds += 1n; if (rounds > 5_000n) throw new Error("never sealed"); }
  assert.equal(rounds, (requiredGross + 233n) / 234n, "seals on the first round whose cumulative funding reaches the gross gate");
  assert.equal(state.lottery.netPrize, 50_000n, "the sealed prize is exactly the base after the founder fee");
  assert.equal(state.lottery.readyForDraw, false, "no draw until the reset reserve is also sealed");
  while (!state.lottery.readyForDraw) { state = round(state).state; rounds += 1n; if (rounds > 5_000n) throw new Error("never armed"); }
  assert.equal(rounds, (requiredGross + resetGross + 233n) / 234n, "arms once prize gross + reset gross are both covered");
  assert.equal(state.lottery.resetReserve, resetGross);
  const hit = simulateIteration(state, policy, { players, crashBps: 20_000n, lotteryOutcome: "hit" });
  assert.equal(hit.lotteryEvent, "hit");
  assert.equal(hit.state.totals.lotteryWinnerPayouts, 50_000n);
  assert.equal(hit.state.lottery.cycleBase, 100_000n, "ratchet by max(5%, 50k)");
  assert.equal(hit.state.lottery.netPrize, 100_000n, "next prize re-seeded from the sealed reserve");
});

test("legacy default rooms re-base only an unsealed, undisplayed target at the round boundary", () => {
  const v2 = { ...DEFAULT_PLAYTEST_POLICY, ...PLAYTEST_PRIZE_PROFILES.v2 };
  const funding = initialSimulationState(v2);
  funding.lottery.pendingFunding = 4_321n; funding.protectedPrincipal = 999n;
  const rebased = rebasePlaytestLotteryTarget(funding, 1_000_000n, DEFAULT_PLAYTEST_POLICY.lotteryInitialBase);
  assert.ok(rebased);
  assert.equal(rebased.lottery.cycleBase, 50_000n);
  assert.equal(rebased.lottery.nextPrizeTarget, 50_000n);
  assert.equal(rebased.lottery.pendingFunding, 4_321n, "accrued funding is never touched");
  assert.equal(accountedAssets(rebased), accountedAssets(funding), "accounted assets conserved exactly");
  assert.equal(funding.lottery.cycleBase, 1_000_000n, "the stored prior is not mutated");
  const sealed = initialSimulationState(v2);
  sealed.lottery.awaitingSeal = false; sealed.lottery.netPrize = 900_000n;
  assert.equal(rebasePlaytestLotteryTarget(sealed, 1_000_000n, 50_000n), null, "a displayed prize is a promise; never lowered");
  const rolled = initialSimulationState(v2);
  rolled.lottery.rollover = 1n;
  assert.equal(rebasePlaytestLotteryTarget(rolled, 1_000_000n, 50_000n), null);
  const ratcheted = initialSimulationState(v2);
  ratcheted.lottery.cycleBase = 1_050_000n; ratcheted.lottery.nextPrizeTarget = 1_050_000n;
  assert.equal(rebasePlaytestLotteryTarget(ratcheted, 1_000_000n, 50_000n), null, "a table that already paid a jackpot keeps its ratchet");
  assert.equal(rebasePlaytestLotteryTarget(initialSimulationState(DEFAULT_PLAYTEST_POLICY), 50_000n, 50_000n), null);
});

test("pre-Powerboard-provenance snapshots remain replayable", () => {
  const legacy = serializeBigInts(initialSimulationState(DEFAULT_PLAYTEST_POLICY)) as Record<string, unknown>;
  delete (legacy.totals as Record<string, unknown>).powerboardFunded;
  assert.equal(parseSimulationState(legacy).totals.powerboardFunded, 0n);
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

// AUDIT 2026-09-02 (Workstream F): authoritative fixture pinning the ball
// derivation. If the sha256("<reveal>:powerboard:number") mapping ever
// changes, replayed/settled rounds would silently present a DIFFERENT ball
// than the one committed — this literal fixture makes that impossible to
// miss. reveal = "ab" x 32 must always draw ball 11 of 16 (a miss).
test("the committed-reveal → displayed-ball mapping is pinned by fixture", () => {
  const draw = powerboardRoundDraw("ab".repeat(32));
  assert.deepEqual(draw, { drawnNumber: 11, winningNumber: 1, oddsOneIn: 16, rawHit: false });
});
