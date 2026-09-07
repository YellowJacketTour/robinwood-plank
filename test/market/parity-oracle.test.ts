import assert from "node:assert/strict";
import test from "node:test";
import { compareField, compareCollection, summarise } from "../../lib/market/multichain/parity/parity";

test("field parity: relative tolerance per field; missing on either side is unverified, never a failure", () => {
  assert.equal(compareField("floor", 1.0, 1.04).verdict, "match");
  assert.equal(compareField("floor", 1.0, 1.12).verdict, "near");
  assert.equal(compareField("floor", 1.0, 1.5).verdict, "diverge");
  assert.equal(compareField("supply", 10_000, 10_001).verdict, "match");
  assert.equal(compareField("supply", 10_000, 9_000).verdict, "diverge");
  assert.equal(compareField("sales24h", 0, 0).verdict, "match");
  assert.equal(compareField("listed", null, 5).verdict, "unverified");
  assert.equal(compareField("volume24h", 3, null).verdict, "unverified");
});

test("collection parity is the worst verified field; a chain summary reports agreement over verified rows only", () => {
  const good = compareCollection({ floor: 7.05, listed: 196, supply: 9_998, sales24h: 16, volume24h: 49.3 }, { floor: 7.1, listed: 200, supply: 9_998, sales24h: 15, volume24h: 47 });
  assert.equal(good.verdict, "match");
  assert.equal(good.verifiedFields, 5);
  const bad = compareCollection({ floor: 0.03, listed: 22 }, { floor: 0.012, listed: 82 });
  assert.equal(bad.verdict, "diverge", "the RobinWood case before the merged-book fix diverges from the reference");
  const none = compareCollection({ floor: 1 }, {});
  assert.equal(none.verdict, "unverified");
  const s = summarise([good, bad, none]);
  assert.deepEqual({ sampled: s.sampled, verified: s.verified, match: s.match, diverge: s.diverge }, { sampled: 3, verified: 2, match: 1, diverge: 1 });
  assert.equal(s.agreement, 0.5);
});
