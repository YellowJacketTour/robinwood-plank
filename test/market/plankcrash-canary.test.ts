import assert from "node:assert/strict";
import test from "node:test";
import { assertCanaryNetwork, summarizeBlockCadence } from "../../lib/plankcrash-canary";

test("signed canary is structurally unable to run on mainnet", () => {
  assert.doesNotThrow(() => assertCanaryNetwork(46_630n, true));
  assert.throws(() => assertCanaryNetwork(4_663n, true), /SIGNED_CANARY_REFUSED/);
  assert.doesNotThrow(() => assertCanaryNetwork(4_663n, false));
});

test("canary cadence reports continuity and observed timing", () => {
  const summary = summarizeBlockCadence([
    { number: 10, timestamp: 100, hash: "0xaa", parentHash: "0x00", observedAtMs: 1_000 },
    { number: 11, timestamp: 100, hash: "0xbb", parentHash: "0xaa", observedAtMs: 1_120 },
    { number: 12, timestamp: 101, hash: "0xcc", parentHash: "0xbb", observedAtMs: 1_260 },
  ]);
  assert.equal(summary.parentContinuity, true);
  assert.equal(summary.observedIntervalMs.median, 120);
  assert.deepEqual(summary.chainTimestampStepsSeconds, { min: 0, max: 1 });
});

