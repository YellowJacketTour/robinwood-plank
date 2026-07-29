import assert from "node:assert/strict";
import test from "node:test";
import { collectionFloorWei, formatPremiumBps, tierFloors } from "../../lib/market/floors";
import type { RarityLookup } from "../../lib/market/rarityClient";

test("collectionFloorWei picks the cheapest listing", () => {
  const floor = collectionFloorWei([
    { priceWei: "3000000000000000000" },
    { priceWei: "1000000000000000000" },
    { priceWei: "2000000000000000000" },
  ]);
  assert.equal(floor?.toString(), "1000000000000000000");
});

test("tierFloors computes premium vs collection floor", () => {
  const rarity = new Map<string, RarityLookup>([
    ["1", { name: "A", tier: "Common", rank: 100, percentile: 10 }],
    ["2", { name: "B", tier: "Legendary", rank: 1, percentile: 99 }],
    ["3", { name: "C", tier: "Legendary", rank: 2, percentile: 98 }],
  ]);
  const listings = [
    { tokenId: "1", priceWei: "1000000000000000000" }, // 1 Ξ common floor
    { tokenId: "2", priceWei: "1500000000000000000" }, // 1.5 Ξ leg
    { tokenId: "3", priceWei: "2000000000000000000" }, // 2 Ξ leg
  ];
  const rows = tierFloors(listings, rarity);
  const common = rows.find((r) => r.tier === "Common")!;
  const leg = rows.find((r) => r.tier === "Legendary")!;
  assert.equal(common.floorWei?.toString(), "1000000000000000000");
  assert.equal(common.premiumBps, 0);
  assert.equal(leg.floorWei?.toString(), "1500000000000000000");
  assert.equal(leg.premiumBps, 5000); // +50%
  assert.equal(leg.listed, 2);
});

test("formatPremiumBps", () => {
  assert.equal(formatPremiumBps(0), "floor");
  assert.equal(formatPremiumBps(5000), "+50%");
  assert.equal(formatPremiumBps(-250), "−2.5%");
  assert.equal(formatPremiumBps(null), "—");
});
