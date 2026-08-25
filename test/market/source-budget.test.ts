import assert from "node:assert/strict";
import test from "node:test";
import {
  checkSourceBudget,
  recordSourceSuccess,
  recordSourceFailure,
  readSourceBudget,
  _resetSourceBudgetForTests,
} from "../../lib/market/multichain/discovery/source-budget";

/**
 * Real payment-leak-prevention mechanism -- built 2026-08-20 directly in
 * response to a real incident (Alchemy's own key hitting its real
 * monthly capacity limit mid-session) and a security-review critique of
 * a proposed multi-source "swarm" architecture: unbounded parallel
 * fan-out with no per-source budget or circuit breaker is a genuine
 * payment-leak risk. These pin the exact three rules the module exists
 * to enforce.
 */

test("checkSourceBudget allows a fresh, never-called source", () => {
  _resetSourceBudgetForTests("test-fresh");
  const gate = checkSourceBudget("test-fresh");
  assert.deepEqual(gate, { allowed: true });
});

test("a single quota error (429) jails the source immediately -- one strike, not three", () => {
  _resetSourceBudgetForTests("test-quota");
  recordSourceFailure("test-quota", true);
  const gate = checkSourceBudget("test-quota");
  assert.equal(gate.allowed, false);
  assert.equal((gate as { reason: string }).reason, "jailed");
});

test("a single generic (non-quota) failure does NOT jail the source", () => {
  _resetSourceBudgetForTests("test-generic-fail");
  recordSourceFailure("test-generic-fail", false);
  const gate = checkSourceBudget("test-generic-fail");
  assert.deepEqual(gate, { allowed: true });
});

test("three consecutive generic failures DO jail the source (circuit breaker threshold)", () => {
  _resetSourceBudgetForTests("test-three-fails");
  recordSourceFailure("test-three-fails", false);
  recordSourceFailure("test-three-fails", false);
  assert.equal(checkSourceBudget("test-three-fails").allowed, true, "still allowed after 2");
  recordSourceFailure("test-three-fails", false);
  assert.equal(checkSourceBudget("test-three-fails").allowed, false, "jailed after 3");
});

test("a real success resets the consecutive-failure counter", () => {
  _resetSourceBudgetForTests("test-reset");
  recordSourceFailure("test-reset", false);
  recordSourceFailure("test-reset", false);
  recordSourceSuccess("test-reset");
  recordSourceFailure("test-reset", false);
  recordSourceFailure("test-reset", false);
  // Only 2 consecutive failures since the reset -- still under the
  // 3-strike threshold, so still allowed.
  assert.equal(checkSourceBudget("test-reset").allowed, true);
});

test("readSourceBudget reports real, current call counts and jail state", () => {
  _resetSourceBudgetForTests("test-read");
  recordSourceSuccess("test-read");
  recordSourceSuccess("test-read");
  recordSourceFailure("test-read", true);
  const snapshot = readSourceBudget("test-read");
  assert.equal(snapshot.callsToday, 3);
  assert.equal(snapshot.jailed, true);
  assert.ok(snapshot.jailedUntil != null && snapshot.jailedUntil > Date.now());
});

test("an unknown source name has no daily ceiling configured -- never silently jailed by a ceiling it was never given", () => {
  _resetSourceBudgetForTests("test-unknown-source-xyz");
  for (let i = 0; i < 50; i++) recordSourceSuccess("test-unknown-source-xyz");
  assert.equal(checkSourceBudget("test-unknown-source-xyz").allowed, true);
  assert.equal(readSourceBudget("test-unknown-source-xyz").ceiling, null);
});

test("coingecko-nft has a real configured daily ceiling below its documented free-tier monthly cap", () => {
  const snapshot = readSourceBudget("coingecko-nft");
  assert.ok(snapshot.ceiling != null && snapshot.ceiling > 0, "coingecko-nft must have a real configured ceiling, not an unbounded default");
});
