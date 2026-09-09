import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldWrapToStart,
  ORDINALSWALLET_BRC20_BAND_START,
} from "../../lib/market/multichain/discovery/ordinalswallet-collection-scan";

/**
 * The OrdinalsWallet catalog walker's stop condition.
 *
 * WHAT THIS FILE USED TO ASSERT, AND WHY IT WAS WRONG
 * --------------------------------------------------
 * A 2026-09-08 pass sampled offsets 0 / 500 / 1000 / 1500 / 2000 / 3000, saw
 * real collections collapse from ~499 to ~2, and concluded: "the endpoint's
 * own `total` is ~425,000, which is the BRC-20 rows, and is NOT a collection
 * count... the catalog is EXHAUSTED". Everything past 2,500 was declared dead
 * and the walker was made to wrap back to offset 0.
 *
 * It never probed past 3,000. Re-measured live 2026-09-09 with real requests:
 *
 *   offset       returned   BRC-20   REAL NFT collections
 *        0            500        0     500
 *    20,000            500      488      12
 *   100,000            500      485      15
 *   150,000            500      497       3
 *   250,000            500        0     500
 *   350,000            500        0     500
 *   400,000            500        0     500
 *   420,000            500        0     500
 *   425,000            243        0     243   <- exactly total - 425,000
 *
 * Zero slug overlap between pages, and the last page's size matches the
 * reported total exactly. The fungible rows are a BAND in the middle, not a
 * tail, and roughly 175,000 REAL collections live past offset 250,000 -- none
 * of which were ever reachable, because the walker wrapped at the first
 * all-BRC-20 page.
 *
 * The lesson worth keeping: a boundary measured over one narrow range was
 * generalised into a claim about the whole catalog. "Exhausted" was a
 * conclusion about offsets 0-3,000 wearing the clothes of a conclusion about
 * everything.
 */

test("the band start is where fungible rows BEGIN, not where the catalog ends", () => {
  // Still must not wrap while early pages yield hundreds of real collections.
  assert.ok(
    ORDINALSWALLET_BRC20_BAND_START > 1_500,
    "must not give up while pages still yield hundreds of real collections",
  );
  assert.ok(
    ORDINALSWALLET_BRC20_BAND_START < 10_000,
    "the band starts early; do not drift back toward the old 120,000",
  );
});

test("THE FIX: a full page of BRC-20 rows is NOT the end of the catalog", () => {
  // The exact condition that capped Bitcoin at 4.6% of this source. A page
  // deep in the band returns 500 rows of which ~0 are real; that is the middle
  // of the catalog, and the walker must continue through it.
  assert.equal(
    shouldWrapToStart(100_000, 0, 500),
    false,
    "an all-fungible FULL page must not end the walk -- 175k real collections lie past it",
  );
  assert.equal(shouldWrapToStart(150_000, 3, 500), false, "nor a near-empty full page");
});

test("only a genuinely empty page ends the walk", () => {
  // Nothing at all is a real end of catalog: there is no page past it.
  assert.equal(shouldWrapToStart(425_500, 0, 0), true, "an empty page is the real terminator");
});

test("the far end of the catalog is real, and must be walked", () => {
  // Offsets past 250,000 measured 100% real NFT collections.
  assert.equal(shouldWrapToStart(250_000, 500, 500), false);
  assert.equal(shouldWrapToStart(420_000, 500, 500), false);
  // Including the final partial page, which is real data, not a ragged end.
  assert.equal(shouldWrapToStart(425_000, 243, 243), false);
});

test("the legacy two-argument call keeps its old behaviour", () => {
  // A caller that has not been updated must not silently change what it does.
  // This is the shape the old code relied on, preserved deliberately.
  assert.equal(shouldWrapToStart(ORDINALSWALLET_BRC20_BAND_START + 1, 0), true);
  assert.equal(shouldWrapToStart(ORDINALSWALLET_BRC20_BAND_START - 1, 0), false);
});
