import assert from "node:assert/strict";
import test from "node:test";
import { applyFilters, EMPTY_FILTERS } from "../../components/market/FilterBar";

const items = [
  { tokenId: "1", priceWei: "1000000000000000000" }, // 1 ETH
  { tokenId: "12", priceWei: "500000000000000000" }, // 0.5 ETH
  { tokenId: "234", priceWei: "2500000000000000000" }, // 2.5 ETH
];

test("no filters returns everything", () => {
  assert.equal(applyFilters(items, EMPTY_FILTERS).length, 3);
});

test("token id search matches as a substring", () => {
  const out = applyFilters(items, { ...EMPTY_FILTERS, query: "2" });
  assert.deepEqual(
    out.map((i) => i.tokenId),
    ["12", "234"]
  );
});

test("min and max bounds are inclusive and precise in wei", () => {
  const exact = applyFilters(items, { ...EMPTY_FILTERS, minEth: "1", maxEth: "1" });
  assert.deepEqual(
    exact.map((i) => i.tokenId),
    ["1"]
  );
});

test("fractional bounds do not lose precision", () => {
  const out = applyFilters(items, { ...EMPTY_FILTERS, minEth: "0.5", maxEth: "1" });
  assert.deepEqual(
    out.map((i) => i.tokenId),
    ["1", "12"]
  );
});

test("a half-typed bound hides nothing rather than filtering everything out", () => {
  // "0." parses to null (absent), not to zero — otherwise typing a decimal
  // would blank the grid mid-keystroke.
  assert.equal(applyFilters(items, { ...EMPTY_FILTERS, minEth: "0." }).length, 3);
  assert.equal(applyFilters(items, { ...EMPTY_FILTERS, maxEth: "abc" }).length, 3);
});

test("an unparseable price is excluded rather than throwing", () => {
  const dirty = [...items, { tokenId: "99", priceWei: "not-a-number" }];
  assert.equal(applyFilters(dirty, EMPTY_FILTERS).length, 3);
});

test("collection-wide orders with no token id are excluded by a token search", () => {
  const withAny = [...items, { tokenId: undefined, priceWei: "100" }];
  assert.equal(applyFilters(withAny, { ...EMPTY_FILTERS, query: "1" }).length, 2);
  // ...but survive when no search is active.
  assert.equal(applyFilters(withAny, EMPTY_FILTERS).length, 4);
});

test("tier filter combines with price/search — the actual point of a combined filter", () => {
  const rarityMap = new Map([
    ["1", { tier: "Rare" as const, rank: 1, percentile: 90 }],
    ["12", { tier: "Common" as const, rank: 900, percentile: 10 }],
    ["234", { tier: "Rare" as const, rank: 2, percentile: 88 }],
  ]);
  // Rare tier alone: #1 and #234.
  const rareOnly = applyFilters(items, { ...EMPTY_FILTERS, tier: "Rare" }, rarityMap);
  assert.deepEqual(rareOnly.map((i) => i.tokenId), ["1", "234"]);

  // Rare tier AND price >= 2 ETH: only #234 — proves tier and price compose,
  // not just each filter working in isolation.
  const rareAndExpensive = applyFilters(
    items,
    { ...EMPTY_FILTERS, tier: "Rare", minEth: "2" },
    rarityMap
  );
  assert.deepEqual(rareAndExpensive.map((i) => i.tokenId), ["234"]);
});

test("multiple rarity tiers combine with OR semantics", () => {
  const rarity = new Map([
    ["1", { name: "One", tier: "Rare" as const, rank: 1, percentile: 99 }],
    ["12", { name: "Two", tier: "Epic" as const, rank: 2, percentile: 98 }],
    ["234", { name: "Three", tier: "Common" as const, rank: 3, percentile: 97 }],
  ]);
  const filtered = applyFilters(
    items,
    { ...EMPTY_FILTERS, tiers: ["Rare", "Epic"] },
    rarity
  );
  assert.deepEqual(filtered.map((item) => item.tokenId), ["1", "12"]);
});

test("tier filter excludes items with no rarity data, and no rarityMap means every tier filter excludes everything (fail closed, never fail open into showing the wrong tier)", () => {
  assert.equal(applyFilters(items, { ...EMPTY_FILTERS, tier: "Rare" }).length, 0);
  const partialMap = new Map([["1", { tier: "Rare" as const, rank: 1, percentile: 90 }]]);
  const out = applyFilters(items, { ...EMPTY_FILTERS, tier: "Rare" }, partialMap);
  assert.deepEqual(out.map((i) => i.tokenId), ["1"]);
});

test("a collection-wide item (no tokenId) never matches a tier filter", () => {
  const withAny = [...items, { tokenId: undefined, priceWei: "100" }];
  const rarityMap = new Map([["1", { tier: "Rare" as const, rank: 1, percentile: 90 }]]);
  const out = applyFilters(withAny, { ...EMPTY_FILTERS, tier: "Rare" }, rarityMap);
  assert.deepEqual(out.map((i) => i.tokenId), ["1"]);
});
