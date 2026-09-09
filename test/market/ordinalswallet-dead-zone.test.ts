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

/**
 * The write path, which is what actually bounded this lane.
 *
 * The scan awaited TWO statements per collection, sequentially -- up to 1,000
 * round-trips for a page of 500. That is why the mesh lane was pinned to one
 * page per pass, and why traversing the catalog needed ~850 invocations.
 */
import { readFileSync } from "node:fs";
const SCAN = readFileSync(
  "lib/market/multichain/discovery/ordinalswallet-collection-scan.ts",
  "utf8",
).replace(/\r\n/g, "\n");
const LANE = readFileSync("scripts/mesh-lane.ts", "utf8").replace(/\r\n/g, "\n");

test("collection writes are issued concurrently, not one at a time", () => {
  assert.match(SCAN, /WRITE_CONCURRENCY = (\d+)/, "the fan-out must be an explicit constant");
  const c = Number(SCAN.match(/WRITE_CONCURRENCY = (\d+)/)![1]);
  assert.ok(c > 1, "serial writes are the bottleneck this removes");
  // A background archiver must never be what exhausts the connection pool --
  // a real incident in this codebase.
  assert.ok(c <= 32, `${c} concurrent writes from a background lane is too many`);
});

test("the skip count still matches what was actually skipped", () => {
  // Restructuring a loop into filter + batches is exactly where a counter
  // quietly stops matching reality: `skippedEmpty` must account for every row
  // that was not written, or a short pass reports a number that explains
  // nothing.
  assert.match(
    SCAN,
    /skippedEmpty \+= page\.collections\.length - writable\.length/,
    "every unwritten row must still be counted",
  );
  assert.match(
    SCAN,
    /const writable = page\.collections\.filter\(\(e\) => e\.slug && \(e\.total_supply \?\? 0\) > 0\)/,
    "the filter must keep the ORIGINAL admission rule: a slug and a real supply",
  );
});

test("the lane's page budget moved by one step, not by assumption", () => {
  const m = LANE.match(/runOrdinalsWalletCollectionScan\(\{ maxPages: (\d+) \}\)/);
  assert.ok(m, "the lane must call the scan with an explicit budget");
  const pages = Number(m![1]);
  assert.ok(pages > 1, "one page per pass needs ~850 invocations to traverse the catalog");
  // LANE_TIMEOUT_MS killed this lane before. The fix removes a serialisation,
  // it does not abolish the timeout, so the budget must not leap to a number
  // nobody has observed surviving.
  assert.ok(pages <= 25, `${pages} pages/pass assumes a ceiling that has not been measured`);
});
