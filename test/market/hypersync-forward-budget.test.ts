import assert from "node:assert/strict";
import test from "node:test";
import { planForwardScan, shouldContinueForwardScan } from "../../lib/market/multichain/discovery/hypersync-evm-scan";

/**
 * AUDIT lens 1 #2 (Batch E2): the forward discovery scan is time-budgeted
 * against the lane's own sliceSec, not a fixed 10-800 block chunk. Pure
 * planning + continuation helpers, no network.
 */
test("planForwardScan: a fresh chain starts a bounded lookback behind the head, never at block 0 of history", () => {
  const plan = planForwardScan({ height: 1_000_000, cursor: null, sliceSec: 120 });
  assert.equal(plan.toBlock, 1_000_000);
  assert.ok(plan.fromBlock > 900_000 && plan.fromBlock < 1_000_000, `fromBlock ${plan.fromBlock} must be a short lookback`);
  assert.equal(planForwardScan({ height: 10, cursor: null }).fromBlock, 0, "lookback clamps at 0 on a tiny chain");
});

test("planForwardScan: a known cursor resumes at cursor+1 and targets the head", () => {
  const plan = planForwardScan({ height: 5_000, cursor: 4_000, sliceSec: 120 });
  assert.equal(plan.fromBlock, 4_001);
  assert.equal(plan.toBlock, 5_000);
});

test("planForwardScan: budget is a fraction of sliceSec, falls back to a default, and an explicit budgetMs wins", () => {
  const fromSlice = planForwardScan({ height: 1, cursor: 0, sliceSec: 100 });
  assert.equal(fromSlice.budgetMs, 70_000, "70% of a 100 s slice");
  const dflt = planForwardScan({ height: 1, cursor: 0, sliceSec: null });
  assert.ok(dflt.budgetMs > 0 && dflt.budgetMs < 120_000, "default slice budget must be positive and below 120 s");
  assert.equal(planForwardScan({ height: 1, cursor: 0, sliceSec: 100, budgetMs: 1234 }).budgetMs, 1234);
  assert.equal(planForwardScan({ height: 1, cursor: 0, sliceSec: 100, budgetMs: 0 }).budgetMs, 70_000, "non-positive explicit budget ignored");
  assert.ok(fromSlice.maxLogs > 0);
});

test("shouldContinueForwardScan: stops at head, at the time budget, or at the log ceiling -- otherwise keeps paging", () => {
  const base = { nextBlock: 100, toBlock: 1_000, startedAt: 0, now: 1_000, budgetMs: 10_000, logsScanned: 10, maxLogs: 1_000 };
  assert.equal(shouldContinueForwardScan(base), true);
  assert.equal(shouldContinueForwardScan({ ...base, nextBlock: 1_000 }), false, "head reached");
  assert.equal(shouldContinueForwardScan({ ...base, nextBlock: 1_001 }), false, "past head");
  assert.equal(shouldContinueForwardScan({ ...base, now: 10_000 }), false, "budget elapsed (inclusive)");
  assert.equal(shouldContinueForwardScan({ ...base, now: 9_999 }), true, "just inside the budget");
  assert.equal(shouldContinueForwardScan({ ...base, logsScanned: 1_000 }), false, "log ceiling");
});
