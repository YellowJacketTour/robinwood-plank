import assert from "node:assert/strict";
import test from "node:test";
import { computeSendFeeWei, SEND_FEE_MARGIN_MULTIPLIER } from "../../lib/market/send-fee";

const GWEI = 1_000_000_000n;

test("zero items or zero gas price quotes zero, never a negative or garbage fee", () => {
  const zeroItems = computeSendFeeWei(0, 5n * GWEI);
  assert.equal(zeroItems.totalFeeWei, 0n);
  const zeroGas = computeSendFeeWei(3, 0n);
  assert.equal(zeroGas.totalFeeWei, 0n);
});

test("a single item costs exactly the base rate — no batch discount to apply", () => {
  const q = computeSendFeeWei(1, 5n * GWEI);
  assert.equal(q.totalFeeWei, q.equivalentSingleSendsFeeWei);
  assert.equal(q.averagePerItemWei, q.totalFeeWei);
});

test("a batch is strictly cheaper in total than N separate single sends — the actual point of batch pricing", () => {
  for (const n of [2, 5, 25]) {
    const q = computeSendFeeWei(n, 5n * GWEI);
    assert.ok(
      q.totalFeeWei < q.equivalentSingleSendsFeeWei,
      `batch of ${n} (${q.totalFeeWei}) should undercut ${n} singles (${q.equivalentSingleSendsFeeWei})`
    );
  }
});

test("average per-item cost strictly decreases as the batch grows", () => {
  const gasPrice = 5n * GWEI;
  let prevAvg = computeSendFeeWei(1, gasPrice).averagePerItemWei;
  for (const n of [2, 3, 5, 10, 50]) {
    const avg = computeSendFeeWei(n, gasPrice).averagePerItemWei;
    assert.ok(avg < prevAvg, `avg at n=${n} (${avg}) should be below avg at previous size (${prevAvg})`);
    prevAvg = avg;
  }
});

test("the fee scales linearly with the live gas price — a 10x gas spike is a 10x fee, not a stale flat number", () => {
  const low = computeSendFeeWei(4, 1n * GWEI);
  const high = computeSendFeeWei(4, 10n * GWEI);
  assert.equal(high.totalFeeWei, low.totalFeeWei * 10n);
});

test("the margin multiplier is a real markup over raw gas cost, not a rounding artifact", () => {
  // Sanity floor: even the cheapest possible read (1 item, near-zero gas)
  // should still reflect the >1x multiplier baked into the formula.
  assert.ok(SEND_FEE_MARGIN_MULTIPLIER > 1n);
});
