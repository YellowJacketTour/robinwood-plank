import assert from "node:assert/strict";
import test from "node:test";
import {
  monotone,
  observe,
  retract,
  retractAll,
  maxFold,
  countFold,
  sumFold,
  minFold,
  unionFold,
} from "../../lib/market/multichain/monotone";

/**
 * The CALM theorem says a program is coordination-free consistent iff it is
 * MONOTONIC. `max` is a monotone aggregate with NO INVERSE -- and that is not
 * a metaphor, it is the reason the mall ratchet could not be repaired by
 * clearing a field.
 *
 * Measured live 2026-09-08 (archival-ledger.ts's own comment): migration 106
 * cleared Friendship Bracelets' known_supply and set chain_confirmed = FALSE
 * so a better value could be written. That RE-ENABLED the id-inference
 * branch, an Art Blocks token id near 2,038,964 was re-observed, and
 * known_supply came back as 2,000,343 -- LARGER than the 2,000,335 the
 * migration had just cleared.
 *
 * These tests pin the property that makes that impossible: with the evidence
 * kept, withdrawing the poisoned observation recovers the value the remaining
 * evidence supports, rather than leaving a permanent high-water mark.
 */

test("max alone cannot retract -- this is the bug, stated as a test", () => {
  // The shape the codebase has today: a running maximum with no evidence kept.
  let highWater: number | null = null;
  const seeIt = (v: number) => {
    highWater = highWater == null || v > highWater ? v : highWater;
  };
  seeIt(721);
  seeIt(2_038_964); // the Art Blocks mall id
  assert.equal(highWater, 2_038_964);

  // Now learn that observation was wrong. There is nothing to do: the 721 was
  // never kept, so the only "repair" available is to clear the field -- which
  // is exactly what migration 106 did, and why the value came back larger.
  highWater = null;
  seeIt(2_038_964); // the same source is still live and re-observes
  assert.equal(highWater, 2_038_964, "clearing without retracting re-inflates on the very next read");
});

test("a retractable max recovers the value the remaining evidence supports", () => {
  let m = monotone(maxFold, [
    { source: "projected-tokens", value: 721 },
    { source: "artblocks-mall-id", value: 2_038_964 },
  ]);
  assert.equal(m.value, 2_038_964, "before retraction the poisoned observation dominates");

  // "That source was wrong" -- the thing we actually learn.
  m = retract(m, maxFold, "artblocks-mall-id");
  assert.equal(
    m.value,
    721,
    "the value falls back to what the remaining evidence supports, instead of staying at the high-water mark"
  );
});

test("retraction is idempotent and safe on an unknown source", () => {
  let m = monotone(maxFold, [{ source: "a", value: 5 }]);
  m = retract(m, maxFold, "never-seen");
  assert.equal(m.value, 5, "retracting a source that never spoke changes nothing");
  m = retract(m, maxFold, "a");
  m = retract(m, maxFold, "a");
  assert.equal(m.value, null, "retracting twice is not an error -- and empty is null, not 0");
});

test("an empty evidence set is null, never a fabricated zero", () => {
  assert.equal(monotone(maxFold).value, null);
  assert.equal(monotone(minFold).value, null);
  // Count and sum are different: zero observations really is a count of zero.
  assert.equal(monotone(countFold).value, 0);
  assert.equal(monotone(sumFold).value, 0);
});

test("re-observing the same source REPLACES rather than double-counts", () => {
  let m = monotone(sumFold, [{ source: "venue-a", value: 10 }]);
  m = observe(m, sumFold, { source: "venue-a", value: 25 });
  assert.equal(
    m.value,
    25,
    "a vendor correcting itself must not have both its old and new claims counted"
  );
  m = observe(m, sumFold, { source: "venue-b", value: 5 });
  assert.equal(m.value, 30);
});

/**
 * A reorg is a bulk retraction. This is the whole reason the module exists:
 * orphaning a block becomes an ordinary operation on every derived value at
 * once, rather than a bespoke repair per field.
 */
test("a reorg retracts every event in the orphaned block, and the fold corrects itself", () => {
  const fold = countFold;
  let m = monotone(fold, [
    { source: "blk-99:0", value: null },
    { source: "blk-99:1", value: null },
    { source: "blk-100:0", value: null },
    { source: "blk-100:1", value: null },
    { source: "blk-100:2", value: null },
  ]);
  assert.equal(m.value, 5);

  m = retractAll(m, fold, ["blk-100:0", "blk-100:1", "blk-100:2"]);
  assert.equal(m.value, 2, "the orphaned block's contribution is gone, with no special-case path");
});

test("retracting nothing returns the same object, so callers can cheaply detect no-ops", () => {
  const m = monotone(countFold, [{ source: "a", value: null }]);
  const same = retractAll(m, countFold, ["x", "y"]);
  assert.equal(same, m, "an identity return makes 'nothing changed' observable without a deep compare");
});

test("a floor across venues is retractable, and empty is unknown rather than free", () => {
  let m = monotone(minFold, [
    { source: "opensea", value: 1_200 },
    { source: "magiceden", value: 900 },
  ]);
  assert.equal(m.value, 900);
  // The cheap listing is cancelled.
  m = retract(m, minFold, "magiceden");
  assert.equal(m.value, 1_200, "the floor RISES when the cheapest listing is withdrawn -- min cannot do this alone");
  m = retract(m, minFold, "opensea");
  assert.equal(m.value, null, "no venue offering it is 'unknown', not a floor of zero");
});

test("a union of holders drops members when their evidence is withdrawn", () => {
  let m = monotone(unionFold, [
    { source: "tx-a", value: ["0xalice", "0xbob"] },
    { source: "tx-b", value: ["0xcarol"] },
  ]);
  assert.deepEqual([...m.value].sort(), ["0xalice", "0xbob", "0xcarol"]);

  m = retract(m, unionFold, "tx-a");
  assert.deepEqual(
    [...m.value].sort(),
    ["0xcarol"],
    "a stale member left behind after retraction is the same bug as putHeader keeping a stale copy"
  );
});

test("the fold is order-independent, so evidence can arrive in any sequence", () => {
  const a = monotone(maxFold, [
    { source: "x", value: 3 },
    { source: "y", value: 9 },
    { source: "z", value: 1 },
  ]);
  const b = monotone(maxFold, [
    { source: "z", value: 1 },
    { source: "x", value: 3 },
    { source: "y", value: 9 },
  ]);
  assert.equal(a.value, b.value, "out-of-order delivery must not change the result");
  // And after the same retraction, both agree.
  assert.equal(retract(a, maxFold, "y").value, retract(b, maxFold, "y").value);
});

test("value is always exactly the fold of the observations, never patched independently", () => {
  // The invariant that keeps the value recomputable. If a caller could set
  // `value` directly, retraction would silently stop being correct.
  let m = monotone(maxFold, [{ source: "a", value: 4 }]);
  m = observe(m, maxFold, { source: "b", value: 11 });
  m = observe(m, maxFold, { source: "c", value: 7 });
  m = retract(m, maxFold, "b");
  const recomputed = [...m.observations.values()].reduce<number | null>(
    (acc, v) => (acc == null || v > acc ? v : acc),
    null
  );
  assert.equal(m.value, recomputed, "the carried value and a fresh fold of the evidence must agree");
  assert.equal(m.value, 7);
});
