import assert from "node:assert/strict";
import test from "node:test";
import { initialSimulationState } from "../../lib/casino/simulation";
import {
  bettingRoundId,
  canonicalJson, crashDurationMs, DEFAULT_PLAYTEST_POLICY, injectSimulationState, multiplierAt,
  parsePolicy, parseSimulationState, playtestRulesHash, serializeBigInts,
  simulationCrashBps, powerboardRoundDraw,
} from "../../lib/playtest-room-core";

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
