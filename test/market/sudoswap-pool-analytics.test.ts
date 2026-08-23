import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSudoswapPoolInventory,
  computeVaultRedeemOdds,
  computeVaultPremiumDiscount,
  computeSudoswapPoolMetrics,
  type RarityLookup,
} from "@/lib/market/multichain/sudoswap-pool-analytics";

function rarity(entries: Array<[string, string, number]>): RarityLookup {
  const map = new Map<string, { tier: string; score: number }>();
  for (const [id, tier, score] of entries) map.set(id, { tier, score });
  return { byTokenId: map };
}

test("computeSudoswapPoolInventory: sell-to-pool adds, buy-from-pool removes, chronological order matters", () => {
  const held = computeSudoswapPoolInventory([
    { direction: "buy-from-pool", tokenIds: ["1"], blockNumber: 5, logIndex: 0 }, // out-of-order, applied last
    { direction: "sell-to-pool", tokenIds: ["1", "2"], blockNumber: 1, logIndex: 0 },
    { direction: "sell-to-pool", tokenIds: ["3"], blockNumber: 2, logIndex: 0 },
  ]);
  assert.deepEqual([...held].sort(), ["2", "3"]);
});

test("computeSudoswapPoolInventory: buy-from-pool for an unseen token (incomplete history) is a safe no-op, never negative", () => {
  const held = computeSudoswapPoolInventory([{ direction: "buy-from-pool", tokenIds: ["99"], blockNumber: 1, logIndex: 0 }]);
  assert.equal(held.size, 0);
});

test("computeSudoswapPoolInventory: empty fills -> empty inventory", () => {
  assert.equal(computeSudoswapPoolInventory([]).size, 0);
});

test("computeVaultRedeemOdds: empty vault reports zero everywhere, no division-by-zero garbage", () => {
  const odds = computeVaultRedeemOdds([], rarity([]));
  assert.equal(odds.totalHeld, 0);
  assert.equal(odds.knownCount, 0);
  assert.equal(odds.unknownCount, 0);
  for (const tier of Object.keys(odds.byTier)) {
    assert.equal(odds.byTier[tier as keyof typeof odds.byTier].count, 0);
    assert.equal(odds.byTier[tier as keyof typeof odds.byTier].probability, 0);
  }
});

test("computeVaultRedeemOdds: single-item vault gives that tier probability 1", () => {
  const odds = computeVaultRedeemOdds(["7"], rarity([["7", "Legendary", 10]]));
  assert.equal(odds.totalHeld, 1);
  assert.equal(odds.knownCount, 1);
  assert.equal(odds.byTier.Legendary.count, 1);
  assert.equal(odds.byTier.Legendary.probability, 1);
  assert.equal(odds.byTier.Common.probability, 0);
});

test("computeVaultRedeemOdds: real worked example -- 12 of 340 Legendary => ~3.5%", () => {
  const entries: Array<[string, string, number]> = [];
  for (let i = 0; i < 340; i++) entries.push([String(i), i < 12 ? "Legendary" : "Common", i < 12 ? 10 : 1]);
  const held = entries.map(([id]) => id);
  const odds = computeVaultRedeemOdds(held, rarity(entries));
  assert.equal(odds.totalHeld, 340);
  assert.equal(odds.byTier.Legendary.count, 12);
  assert.ok(Math.abs(odds.byTier.Legendary.probability - 12 / 340) < 1e-9);
});

test("computeVaultRedeemOdds: missing rarity data is honestly excluded, not assumed Common", () => {
  const odds = computeVaultRedeemOdds(["1", "2", "3"], rarity([["1", "Legendary", 10]]));
  assert.equal(odds.totalHeld, 3);
  assert.equal(odds.knownCount, 1);
  assert.equal(odds.unknownCount, 2);
  assert.equal(odds.byTier.Legendary.probability, 1); // conditional on known-rarity tokens only
});

test("computeVaultPremiumDiscount: empty vault returns null with a reason, never a fabricated number", () => {
  const out = computeVaultPremiumDiscount({
    heldTokenIds: [],
    raritySnapshot: rarity([]),
    floorPriceWei: 1_000_000n,
    sharePriceWei: 1_000_000n,
  });
  assert.equal(out.premiumDiscountPct, null);
  assert.equal(out.rarityWeightedInventoryValueWei, null);
  assert.ok(out.reason);
});

test("computeVaultPremiumDiscount: single item at exactly average score => rarity-weighted value == floor, 0% premium/discount", () => {
  const snap = rarity([
    ["1", "Common", 4],
    ["2", "Common", 4],
  ]);
  const out = computeVaultPremiumDiscount({
    heldTokenIds: ["1"],
    raritySnapshot: snap,
    floorPriceWei: 1_000_000_000n,
    sharePriceWei: 1_000_000_000n,
  });
  assert.equal(out.rarityWeightedInventoryValueWei, 1_000_000_000n);
  assert.ok(Math.abs((out.premiumDiscountPct ?? NaN) - 0) < 1e-6);
});

test("computeVaultPremiumDiscount: inventory skewed rare vs a floor-equivalent share price is a real discount", () => {
  // Collection average score is 2 (mix of 1s and 4s); the vault holds only
  // the 4-score (2x average) token, so rarity-weighted value should be 2x
  // floor. A share price still at floor is therefore priced at a real 50%
  // discount to what the vault's actual inventory is worth.
  const snap = rarity([
    ["1", "Common", 1],
    ["2", "Common", 1],
    ["3", "Legendary", 4],
  ]);
  const out = computeVaultPremiumDiscount({
    heldTokenIds: ["3"],
    raritySnapshot: snap,
    floorPriceWei: 1_000_000_000n,
    sharePriceWei: 1_000_000_000n,
  });
  assert.equal(out.rarityWeightedInventoryValueWei, 2_000_000_000n);
  assert.ok(Math.abs((out.premiumDiscountPct ?? NaN) - -50) < 1e-6);
});

test("computeVaultPremiumDiscount: missing rarity data for held tokens is excluded, honest null when none are scored", () => {
  const out = computeVaultPremiumDiscount({
    heldTokenIds: ["1", "2"],
    raritySnapshot: rarity([["9", "Common", 1]]), // neither held token is scored
    floorPriceWei: 1_000_000n,
    sharePriceWei: 1_000_000n,
  });
  assert.equal(out.rarityWeightedInventoryValueWei, null);
  assert.ok(out.reason?.includes("none of the vault's real held tokens"));
});

test("computeVaultPremiumDiscount: no real floor price avg (avgScore <= 0) is honestly null, not divide-by-zero", () => {
  const out = computeVaultPremiumDiscount({
    heldTokenIds: ["1"],
    raritySnapshot: rarity([["1", "Common", 0]]),
    floorPriceWei: 1_000_000n,
    sharePriceWei: 1_000_000n,
  });
  assert.equal(out.premiumDiscountPct, null);
});

test("computeSudoswapPoolMetrics: assembles a full real row from fills + rarity + floor", () => {
  const snap = rarity([
    ["1", "Legendary", 10],
    ["2", "Common", 2],
  ]);
  const nowSec = 1_700_000_000;
  const metrics = computeSudoswapPoolMetrics({
    chainSlug: "eth-mainnet",
    poolAddress: "0xpool",
    nftContract: "0xnft",
    fills: [
      { direction: "sell-to-pool", tokenIds: ["1"], blockNumber: 1, logIndex: 0, blockTimestampSec: nowSec - 1000, currencyToken: "0xweth", priceWei: "100" },
      { direction: "sell-to-pool", tokenIds: ["2"], blockNumber: 2, logIndex: 0, blockTimestampSec: nowSec - 2000, currencyToken: "0xweth", priceWei: "50" },
    ],
    raritySnapshot: snap,
    floorPriceWei: 40n,
    nowSec,
  });
  assert.equal(metrics.inventoryCount, 2);
  assert.equal(metrics.lastPriceWei, "50");
  assert.equal(metrics.sales24h, 2);
  assert.equal(metrics.volume24hWei, "150");
  assert.equal(metrics.redeemOdds.knownCount, 2);
  assert.equal(metrics.redeemOdds.byTier.Legendary.count, 1);
  assert.notEqual(metrics.premiumDiscount.premiumDiscountPct, null);
});

test("computeSudoswapPoolMetrics: pool with no decoded price ever -> honest nulls, not a guessed price", () => {
  const metrics = computeSudoswapPoolMetrics({
    chainSlug: "eth-mainnet",
    poolAddress: "0xpool",
    nftContract: "0xnft",
    fills: [{ direction: "sell-to-pool", tokenIds: ["1"], blockNumber: 1, logIndex: 0, blockTimestampSec: 1_700_000_000, currencyToken: null, priceWei: null }],
    raritySnapshot: rarity([["1", "Common", 1]]),
    floorPriceWei: 100n,
    nowSec: 1_700_000_000,
  });
  assert.equal(metrics.lastPriceWei, null);
  assert.equal(metrics.premiumDiscount.premiumDiscountPct, null);
  assert.equal(metrics.volume24hWei, "0");
});
