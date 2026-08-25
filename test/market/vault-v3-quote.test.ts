import assert from "node:assert/strict";
import test from "node:test";
import { quoteBuy, quoteEthForExactShares, type V3Snapshot } from "../../lib/market/vault-v3";

function pool(eth: bigint, shares: bigint, feeBps = 30): V3Snapshot {
  return { ethReserve: eth, shareReserve: shares, swapFeeBps: feeBps } as V3Snapshot;
}

test("exact-share quote buys at least the requested redemption shortfall", () => {
  const snap = pool(574_000_000_000_000_000n, 39_000_000_000_000_000_000n);
  const need = 1_000_000_000_000_000_000n;
  const ethIn = quoteEthForExactShares(need, snap);
  assert.notEqual(ethIn, null);
  assert.ok(quoteBuy(ethIn!, snap) >= need);
  if (ethIn! > 0n) assert.ok(quoteBuy(ethIn! - 1n, snap) < need);
});

test("exact-share quote handles partial wallet shortfalls", () => {
  const snap = pool(574_000_000_000_000_000n, 39_000_000_000_000_000_000n);
  const need = 125_000_000_000_000_000n;
  const ethIn = quoteEthForExactShares(need, snap);
  assert.notEqual(ethIn, null);
  assert.ok(quoteBuy(ethIn!, snap) >= need);
});

test("exact-share quote fails closed when pool depth cannot satisfy the redeem", () => {
  const snap = pool(1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n);
  assert.equal(quoteEthForExactShares(1_000_000_000_000_000_000n, snap), null);
});
