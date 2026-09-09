import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The "known creator" badge, and why coverage looked broken.
 *
 * The checkmark next to a collection means creator_handle OR creator_ens is
 * non-null. It is not a verification record and not a vendor is_verified
 * flag -- it is a scraped Twitter handle or an ENS name. Bitcoin rows look
 * fully covered because three Ordinals vendors hand the Twitter link back
 * inline with the catalog listing, so one sweep fills everything. Ethereum
 * is covered only where OpenSea stats or the rarity indexer happened to run.
 *
 * The backfill lane that was supposed to close that gap filled ~11 handles
 * per pass against 25,000 Ethereum rows (measured 2026-09-07) -- roughly six
 * years to cover one chain. Three throttles compounded, and all three were
 * self-inflicted rather than imposed by any vendor:
 *
 *   1. the row SELECT asked for the wrong thing
 *   2. one flat budget paced free work at the speed of paid work
 *   3. a row the lane never actually asked about was negatively cached for
 *      seven days anyway
 */

const LANE = readFileSync(
  "lib/market/multichain/discovery/creator-identity.ts",
  "utf8"
).replace(/\r\n/g, "\n");

/** The SELECT, bounded by real terminators rather than a fixed offset. */
function selectSql(): string {
  const start = LANE.indexOf("SELECT c.contract_address");
  assert.ok(start > 0, "the row selection must exist");
  const end = LANE.indexOf("LIMIT $2", start);
  assert.ok(end > start, "the selection must be bounded");
  return LANE.slice(start, end);
}

test("the lane selects rows with NO identity, not rows missing one field", () => {
  const sql = selectSql();
  // The badge renders on (handle OR ens). Selecting `handle IS NULL OR ens
  // IS NULL` therefore re-picks rows that ALREADY show a checkmark, on every
  // pass, forever -- starving the rows that actually render a missing badge.
  assert.ok(
    !/creator_handle IS NULL OR c\.creator_ens IS NULL/.test(sql),
    "OR re-selects rows that already display a badge"
  );
  assert.match(
    sql,
    /creator_handle IS NULL AND c\.creator_ens IS NULL/,
    "the lane must ask for rows with no identity at all"
  );
});

test("the free on-chain path is not throttled to the paid vendor's pace", () => {
  // owner() over the public RPC pool and an ENS reverse lookup cost nothing
  // against any third-party limit. One flat budget made them wait anyway.
  const perPass = LANE.match(/const PER_PASS = (\d+);/);
  assert.ok(perPass, "PER_PASS must exist");
  assert.ok(
    Number(perPass[1]) >= 200,
    `the row budget must not be pinned to the vendor pace (saw ${perPass?.[1]})`
  );
  const cg = LANE.match(/const CG_PER_PASS = (\d+);/);
  assert.ok(cg, "a separate, small budget must bound the paced vendor call");
  assert.ok(Number(cg[1]) < Number(perPass[1]), "the vendor budget must be the smaller one");
});

test("a pass cannot exceed its own vendor budget", () => {
  // Without this cap a 400-row pass sits in CoinGecko's 6.5s pacer for ~43
  // minutes, gets killed by the lane timeout, and registers nothing -- the
  // exact shape of the ow-catalog lane that could not finish four pages.
  assert.match(LANE, /cgSpent < CG_PER_PASS/, "the paced call must be budget-gated");
  assert.match(LANE, /cgSpent \+= 1/, "and the budget must actually be spent");
});

test("a row the lane never asked about is not cached as a failure", () => {
  // The negative cache holds for 7 days. Applying it to a row that was
  // skipped for budget reasons converts a throughput cap into a week-long
  // blackout for precisely the rows whose badge is missing.
  assert.match(LANE, /askedEverything/, "an unasked row must be distinguishable");
  const idx = LANE.indexOf("askedEverything");
  const after = LANE.slice(idx, LANE.indexOf("}", LANE.indexOf("durableKv.set", idx)));
  assert.match(after, /if \(askedEverything\)/, "the cache write must be conditional");
});

test("the attempt cache is still used for real attempts", () => {
  // The cache is not the enemy: re-querying a collection with genuinely no
  // public identity on every rotation would waste the whole budget.
  assert.match(LANE, /ATTEMPT_TTL_SEC = 7 \* 24 \* 3600/, "the TTL stays 7 days");
  assert.match(LANE, /durableKv\.set\(attemptKey/, "a completed attempt is still remembered");
});

test("marketplace handles are still refused and retracted", () => {
  // A badge asserts authorship. "opensea" is not the creator of anything,
  // and a wrong badge already stored has to be withdrawn, not just blocked
  // going forward. This must survive the throughput work untouched.
  assert.match(LANE, /MARKETPLACE_HANDLES/, "the marketplace filter must remain");
  assert.match(
    LANE,
    /SET creator_handle = NULL/,
    "previously-stored marketplace handles must still be retracted"
  );
});
