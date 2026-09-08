import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldWrapToStart,
  ORDINALSWALLET_DEAD_ZONE_OFFSET,
} from "../../lib/market/multichain/discovery/ordinalswallet-collection-scan";

/**
 * The OrdinalsWallet catalog walker's stop condition.
 *
 * This lane was walking BRC-20 fungible-token rows on every turn and
 * registering nothing, because DEAD_ZONE_OFFSET was 120,000 -- two orders of
 * magnitude past where the catalog stops holding NFT collections.
 *
 * MEASURED LIVE against https://turbo.ordinalswallet.com/collections. Real
 * (non-BRC-20, total_supply > 0) rows per page of 500:
 *
 *   2026-09-07:  offset 0 -> 499, 500 -> 490, 1000 -> 483, 1500 -> 363,
 *                offset 2000 -> 2
 *   2026-09-08:  offset 0 -> 489, 1500 -> 361, 2000 -> 6, 3000 -> 33
 *
 * Two independent probes a day apart agree on the shape: the catalog is
 * front-loaded and collapses just past offset ~1,800. The endpoint's own
 * `total` is ~425,000, which is the BRC-20 rows, and is NOT a collection
 * count. That is why the constant cannot be derived from `total`.
 *
 * WHAT THIS TEST DOES NOT CLAIM. Fixing this does not grow Bitcoin. This
 * source offers ~1,837 real collections and the archive already holds
 * ~19,600 from elsewhere, so the catalog is EXHAUSTED. The value of the fix
 * is that the lane stops paying for a store with nothing left. Bitcoin
 * growth comes from parsing envelopes off-chain, not from this endpoint.
 */

test("the dead zone sits just past where the catalog actually collapses", () => {
  // Both live probes still had hundreds of real rows at offset 1500, so a
  // boundary at or below that would throw away real collections.
  assert.ok(
    ORDINALSWALLET_DEAD_ZONE_OFFSET > 1_500,
    "must not wrap while pages still yield hundreds of real collections",
  );
  // And it must be nowhere near the old value, which is what caused the lane
  // to grind ~118,000 offsets of fungible-token rows every turn.
  assert.ok(
    ORDINALSWALLET_DEAD_ZONE_OFFSET < 10_000,
    "120,000 was wrong by two orders of magnitude; do not drift back toward it",
  );
});

test("a page of pure BRC-20 rows past the dead zone wraps to the start", () => {
  // The measured dead zone: offset 3000+, zero real collections on the page.
  assert.equal(
    shouldWrapToStart(3_000, 0),
    true,
    "grinding the dead zone burns the lane's whole turn and registers nothing",
  );
});

test("a productive page never wraps, even deep in the catalog", () => {
  // Offset 3000 returned 33 real rows on the 2026-09-08 probe. The catalog is
  // not monotone, so 'past the dead zone' alone must not trigger a wrap --
  // only past-the-zone AND nothing found.
  assert.equal(
    shouldWrapToStart(3_000, 33),
    false,
    "a page that still yields real collections must be walked, not abandoned",
  );
  assert.equal(shouldWrapToStart(50_000, 1), false, "one real row is still a reason to continue");
});

test("an empty page inside the front-loaded region does NOT wrap", () => {
  // Below the dead zone an empty page is a transient gap, not exhaustion.
  // Wrapping here would pin the walker at the front forever and it would
  // never reach the ~1,800 real collections that live past offset 500.
  assert.equal(
    shouldWrapToStart(500, 0),
    false,
    "an empty page early in the catalog is not evidence the catalog is spent",
  );
  assert.equal(shouldWrapToStart(0, 0), false);
});

test("the boundary itself is exclusive, so the last real page is still walked", () => {
  assert.equal(
    shouldWrapToStart(ORDINALSWALLET_DEAD_ZONE_OFFSET, 0),
    false,
    "at the boundary we have not yet proven we are past the real rows",
  );
  assert.equal(shouldWrapToStart(ORDINALSWALLET_DEAD_ZONE_OFFSET + 1, 0), true);
});
