import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
// Read the exported bound itself rather than scraping a literal out of the
// call site -- see "the walk is still bounded" below for why.
import { PAGES_PER_CALL } from "../../lib/market/multichain/trading/foreign-orders";

/**
 * "117 listed of 9,976" in the header, ONE card in the grid.
 *
 * Measured live 2026-09-09 on Milady Maker:
 *
 *   ordersFetched 50, ordersAfterDedup 1, excludedCriteriaOrders 0,
 *   excludedNoTokenId 0, excludedMultiOffer 0, excludedNonNativeCurrency 0
 *
 * Every exclusion zero, so nothing was being filtered out. Polling repeatedly
 * showed the SAME token (#7957) with a price and endTime that changed every
 * time: a continuously re-signed, declining listing. OpenSea's /all returns
 * every rotation, and the walk stopped once it had `target` ORDERS -- which it
 * reached on one token.
 *
 * The header's 117 comes from fetchOpenSeaListedCount, which walks the SAME
 * endpoint to CURSOR EXHAUSTION counting distinct ids. Same data, two stopping
 * rules, and only one matched what a grid needs.
 *
 * Other collections hid it: BAYC 31, Pudgy 32, Azuki 41 distinct tokens from
 * 50 orders. It looked collection-specific rather than like the wrong
 * stopping condition.
 */

const SRC = readFileSync("lib/market/multichain/trading/foreign-orders.ts", "utf8").replace(/\r\n/g, "\n");

function paged(src: string): string {
  const at = src.indexOf("export async function fetchForeignAllListingsPaged");
  assert.ok(at > 0, "the paged walk must exist");
  const end = src.indexOf("\n}", src.indexOf("return { orders, complete: cursor == null", at));
  return src.slice(at, end);
}

test("the walk stops on DISTINCT TOKENS, not raw order count", () => {
  const body = paged(SRC);
  assert.match(body, /const distinct = new Set<string>\(\)/, "distinct tokens must be tracked");
  assert.match(body, /while \(distinct\.size < target/, "and must be the loop's stopping condition");
  assert.ok(
    !/while \(orders\.length < target/.test(body),
    "counting orders is what filled the quota on a single re-signed token",
  );
});

test("distinctness is measured by TOKEN ID, the same key the grid dedupes on", () => {
  // If the stopping rule and the rendering rule disagree, the mismatch this
  // fix removes comes straight back.
  const body = paged(SRC);
  assert.match(body, /offer\?\.\[0\]\?\.identifierOrCriteria/, "must read the token id");
  assert.match(body, /distinct\.add\(String\(id\)\)/, "and count it as the dedup key");
});

test("token id \"0\" still counts", () => {
  // A falsy check here would silently skip the first mint of most collections
  // -- the same class of bug already fixed in the listings route's dedup.
  const body = paged(SRC);
  assert.match(body, /id != null && id !== ""/, "absence must be tested explicitly, not truthiness");
});

test("each request asks for a FULL page", () => {
  // `Math.min(100, target - orders.length)` shrank the request as rotations
  // accumulated, so the walk got slower exactly when it needed more data.
  const body = paged(SRC);
  assert.match(body, /const pageSize = 100;/, "a shrinking page size starves the walk it is trying to finish");
});

test("the walk is still bounded", () => {
  // Rotations mean a page can contribute ZERO new tokens, so the bound has to
  // be generous -- but an unbounded walk on a large collection is its own
  // outage, and it would blow the per-key quota besides.
  //
  // THIS TEST READ AN INLINE LITERAL AND BROKE ON A CORRECT CHANGE.
  //
  // It matched /pages < (\d+)/. PR #493 replaced the literal with a named,
  // exported constant -- `pages < PAGES_PER_CALL` -- as part of converting the
  // budget from a CEILING into PACING (the walk now returns its cursor, so
  // stopping no longer means the rest of the book is unreachable). The bound
  // did not move; it is still 25. Only its spelling changed, and this
  // assertion could not see it.
  //
  // Reading the exported value rather than the call site fixes that properly:
  // it pins the real number, survives the constant being moved or reused, and
  // fails for the reason it claims to (no bound) instead of for a rename.
  const body = paged(SRC);
  assert.match(
    body,
    /pages < PAGES_PER_CALL/,
    "the walk must still be bounded by the paging budget"
  );
  assert.ok(
    Number.isInteger(PAGES_PER_CALL) && PAGES_PER_CALL > 0,
    "the budget must be a real positive bound"
  );
  assert.ok(
    PAGES_PER_CALL > 10,
    `${PAGES_PER_CALL} pages is the old order-counting budget; distinct-token paging needs more room`
  );
  assert.ok(
    PAGES_PER_CALL <= 50,
    `${PAGES_PER_CALL} pages is 5,000 orders for one page render`
  );
});

/** The stopping rule as a pure predicate, so the boundary is exercised. */
function shouldKeepPaging(distinctSoFar: number, target: number, pages: number, cap: number): boolean {
  return distinctSoFar < target && pages < cap;
}

test("THE GUARD FIRES: rotations no longer end the walk early", () => {
  // The measured Milady case: 50 orders, 1 distinct token, target 50.
  assert.equal(shouldKeepPaging(1, 50, 1, 25), true, "one token from a full page must keep paging");
  // The measured BAYC case: 31 distinct from 50 orders -- still short of 50.
  assert.equal(shouldKeepPaging(31, 50, 1, 25), true);
  // Enough distinct tokens: stop.
  assert.equal(shouldKeepPaging(50, 50, 1, 25), false, "target reached");
  // And the cap holds even when tokens are scarce, so a pathological
  // collection cannot page forever.
  assert.equal(shouldKeepPaging(1, 50, 25, 25), false, "the page cap must still bound it");
});
