import assert from "node:assert/strict";
import test from "node:test";
import { computeWashSuspicion, type WashCandidateSale } from "../../lib/market/wash-trade-signal";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc".slice(0, 42);
const D = "0xdddddddddddddddddddddddddddddddddddddddd".slice(0, 42);

function sale(overrides: Partial<WashCandidateSale>): WashCandidateSale {
  return { txHash: "0xtx", from: A, to: B, priceWei: "1000", timestamp: "2026-08-20T00:00:00Z", ...overrides };
}

test("computeWashSuspicion flags nothing for real distinct-wallet, one-way trades", () => {
  const sales = [
    sale({ txHash: "0x1", from: A, to: B, priceWei: "1000" }),
    sale({ txHash: "0x2", from: B, to: C, priceWei: "1200" }),
    sale({ txHash: "0x3", from: C, to: D, priceWei: "900" }),
  ];
  const result = computeWashSuspicion(sales);
  assert.equal(result.suspiciousTradeCount, 0);
  assert.equal(result.selfTransferCount, 0);
  assert.equal(result.reciprocalPairCount, 0);
  assert.equal(result.suspicionRatio, 0);
  assert.equal(result.suspiciousTxHashes.size, 0);
  assert.equal(result.totalTradeCount, 3);
});

test("computeWashSuspicion flags an exact self-transfer (same address both sides)", () => {
  const sales = [
    sale({ txHash: "0x1", from: A, to: A, priceWei: "5000" }),
    sale({ txHash: "0x2", from: B, to: C, priceWei: "1000" }),
  ];
  const result = computeWashSuspicion(sales);
  assert.equal(result.selfTransferCount, 1);
  assert.equal(result.suspiciousTradeCount, 1);
  assert.ok(result.suspiciousTxHashes.has("0x1"));
  assert.ok(!result.suspiciousTxHashes.has("0x2"));
  // 5000 / (5000 + 1000) = 5/6
  assert.ok(Math.abs(result.suspicionRatio - 5 / 6) < 1e-9);
});

test("computeWashSuspicion flags a reciprocal same-pair round-trip but not a single one-way resale", () => {
  const sales = [
    // A -> B, then B -> A: a closed loop between the same two wallets.
    sale({ txHash: "0x1", from: A, to: B, priceWei: "1000" }),
    sale({ txHash: "0x2", from: B, to: A, priceWei: "1000" }),
    // A single one-way resale between two OTHER wallets must never trigger.
    sale({ txHash: "0x3", from: C, to: D, priceWei: "1000" }),
  ];
  const result = computeWashSuspicion(sales);
  assert.equal(result.reciprocalPairCount, 2);
  assert.equal(result.suspiciousTradeCount, 2);
  assert.ok(result.suspiciousTxHashes.has("0x1"));
  assert.ok(result.suspiciousTxHashes.has("0x2"));
  assert.ok(!result.suspiciousTxHashes.has("0x3"));
  // 2000 suspicious out of 3000 total.
  assert.ok(Math.abs(result.suspicionRatio - 2 / 3) < 1e-9);
});

test("computeWashSuspicion never flags a same pair trading only once (real resale, no round-trip)", () => {
  const sales = [sale({ txHash: "0x1", from: A, to: B, priceWei: "1000" })];
  const result = computeWashSuspicion(sales);
  assert.equal(result.reciprocalPairCount, 0);
  assert.equal(result.suspiciousTradeCount, 0);
});

test("computeWashSuspicion ignores garbage/zero prices instead of throwing", () => {
  const sales = [
    sale({ txHash: "0x1", from: A, to: A, priceWei: "not-a-number" }),
    sale({ txHash: "0x2", from: A, to: A, priceWei: "0" }),
    sale({ txHash: "0x3", from: B, to: C, priceWei: "500" }),
  ];
  const result = computeWashSuspicion(sales);
  assert.equal(result.totalTradeCount, 1);
  assert.equal(result.suspiciousTradeCount, 0);
  assert.equal(result.suspicionRatio, 0);
});

test("computeWashSuspicion returns ratio 0 with no volume to judge", () => {
  const result = computeWashSuspicion([]);
  assert.equal(result.suspicionRatio, 0);
  assert.equal(result.totalTradeCount, 0);
});
