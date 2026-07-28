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
