import assert from "node:assert/strict";
import test from "node:test";
import { classifyDormancy } from "../../lib/market/multichain/dormancy";

test("classifyDormancy flags a real dormant collection: zero sales, zero volume, no listings", () => {
  const result = classifyDormancy({ sales30d: 0, volume30dWei: "0", listedCount: 0, holderCount: 1 });
  assert.equal(result.dormant, true);
  assert.ok(result.reason && result.reason.includes("30 days"));
});

test("classifyDormancy never flags a collection with real recent sales", () => {
  const result = classifyDormancy({ sales30d: 3, volume30dWei: "9000", listedCount: 0, holderCount: 40 });
  assert.equal(result.dormant, false);
  assert.equal(result.reason, null);
});

test("classifyDormancy never flags a zero-sale collection that still has live listings", () => {
  const result = classifyDormancy({ sales30d: 0, volume30dWei: "0", listedCount: 5, holderCount: 12 });
  assert.equal(result.dormant, false);
});

test("classifyDormancy never treats missing data (never fetched) as confirmed dead", () => {
  const bothNull = classifyDormancy({ sales30d: null, volume30dWei: null, listedCount: null, holderCount: null });
  assert.equal(bothNull.dormant, false);
  const oneNull = classifyDormancy({ sales30d: 0, volume30dWei: null, listedCount: 0, holderCount: null });
  assert.equal(oneNull.dormant, false);
  const otherNull = classifyDormancy({ sales30d: null, volume30dWei: "0", listedCount: 0, holderCount: null });
  assert.equal(otherNull.dormant, false);
});

test("classifyDormancy ignores garbage volume strings rather than crashing", () => {
  const result = classifyDormancy({ sales30d: 0, volume30dWei: "not-a-number", listedCount: 0, holderCount: 1 });
  assert.equal(result.dormant, false);
});
