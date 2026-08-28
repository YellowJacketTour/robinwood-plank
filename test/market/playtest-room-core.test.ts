import assert from "node:assert/strict";
import test from "node:test";
import { initialSimulationState } from "../../lib/casino/simulation";
import {
  canonicalJson, crashDurationMs, DEFAULT_PLAYTEST_POLICY, multiplierAt,
  parsePolicy, parseSimulationState, playtestRulesHash, serializeBigInts,
  simulationCrashBps,
} from "../../lib/playtest-room-core";

test("room rules hash is canonical and stable across key order", () => {
  const a = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
  const b = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
  assert.equal(a, b);
  assert.match(playtestRulesHash(DEFAULT_PLAYTEST_POLICY), /^[0-9a-f]{64}$/);
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
  assert.ok(crash >= 10_000n && crash <= 1_000_000n);
  assert.throws(() => simulationCrashBps("not-a-reveal"));
});

test("authoritative display curve is monotonic and reaches crash on its deadline", () => {
  const start = 1_000_000;
  const crash = 250_000n;
  const duration = crashDurationMs(crash);
  assert.equal(multiplierAt(start, start), 10_000n);
  assert.ok(multiplierAt(start, start + duration / 2) > 10_000n);
  assert.ok(multiplierAt(start, start + duration) >= crash);
});
