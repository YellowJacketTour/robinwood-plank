import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scoreFromCounts,
  nextSiblingExpansionBucket,
  MAX_SIBLING_EXPANSIONS_PER_HOUR,
  ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD,
} from "../../lib/market/multichain/archival-ledger.ts";

test("scoreFromCounts: real positive known_supply -> supply_ratio, capped at 1", () => {
  assert.deepEqual(scoreFromCounts(10_000, 1_204), { archivalScore: 1204 / 10_000, scoreMethod: "supply_ratio" });
  assert.deepEqual(scoreFromCounts(100, 500), { archivalScore: 1, scoreMethod: "supply_ratio" });
  assert.deepEqual(scoreFromCounts(100, 0), { archivalScore: 0, scoreMethod: "supply_ratio" });
});

test("scoreFromCounts: unknown/zero/negative/non-finite supply -> unknown_supply, score stays null (never fabricated)", () => {
  assert.deepEqual(scoreFromCounts(null, 1_204), { archivalScore: null, scoreMethod: "unknown_supply" });
  assert.deepEqual(scoreFromCounts(0, 1_204), { archivalScore: null, scoreMethod: "unknown_supply" });
  assert.deepEqual(scoreFromCounts(-5, 1_204), { archivalScore: null, scoreMethod: "unknown_supply" });
  assert.deepEqual(scoreFromCounts(Number.NaN, 1_204), { archivalScore: null, scoreMethod: "unknown_supply" });
  assert.deepEqual(scoreFromCounts(Number.POSITIVE_INFINITY, 1_204), { archivalScore: null, scoreMethod: "unknown_supply" });
});

test("scoreFromCounts: negative/garbage hydrated count never goes negative or breaks the ratio", () => {
  assert.deepEqual(scoreFromCounts(100, -5), { archivalScore: 0, scoreMethod: "supply_ratio" });
  assert.deepEqual(scoreFromCounts(100, Number.NaN), { archivalScore: 0, scoreMethod: "supply_ratio" });
});

test("nextSiblingExpansionBucket: fresh collection (no prior bucket) is allowed, starts a new bucket", () => {
  const now = new Date("2026-08-25T12:00:00Z");
  const decision = nextSiblingExpansionBucket({ bucketStart: null, countInBucket: 0, now });
  assert.equal(decision.allowed, true);
  assert.equal(decision.newBucketStart.getTime(), now.getTime());
  assert.equal(decision.newCount, 1);
});

test("nextSiblingExpansionBucket: allows up to MAX_SIBLING_EXPANSIONS_PER_HOUR within the same rolling hour", () => {
  const bucketStart = new Date("2026-08-25T12:00:00Z");
  const now = new Date("2026-08-25T12:30:00Z");
  let decision = nextSiblingExpansionBucket({ bucketStart, countInBucket: MAX_SIBLING_EXPANSIONS_PER_HOUR - 1, now });
  assert.equal(decision.allowed, true);
  assert.equal(decision.newCount, MAX_SIBLING_EXPANSIONS_PER_HOUR);
  assert.equal(decision.newBucketStart.getTime(), bucketStart.getTime());
});

test("nextSiblingExpansionBucket: denies once the bucket is at cap and still within the hour", () => {
  const bucketStart = new Date("2026-08-25T12:00:00Z");
  const now = new Date("2026-08-25T12:45:00Z");
  const decision = nextSiblingExpansionBucket({ bucketStart, countInBucket: MAX_SIBLING_EXPANSIONS_PER_HOUR, now });
  assert.equal(decision.allowed, false);
  assert.equal(decision.newCount, MAX_SIBLING_EXPANSIONS_PER_HOUR);
});

test("nextSiblingExpansionBucket: an hour-old-or-more bucket resets even if it was previously at cap", () => {
  const bucketStart = new Date("2026-08-25T12:00:00Z");
  const now = new Date("2026-08-25T13:00:00Z"); // exactly one hour later
  const decision = nextSiblingExpansionBucket({ bucketStart, countInBucket: MAX_SIBLING_EXPANSIONS_PER_HOUR, now });
  assert.equal(decision.allowed, true);
  assert.equal(decision.newBucketStart.getTime(), now.getTime());
  assert.equal(decision.newCount, 1);
});

test("ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD is a real, small positive fraction (sanity guard against accidental 0/1/negative)", () => {
  assert.ok(ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD > 0);
  assert.ok(ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD < 1);
});
