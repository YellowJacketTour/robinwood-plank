import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * The Global Market Hub's performance ceiling was one SQL clause.
 *
 * Measured live against production 2026-09-09, signed in through the backstage
 * door so the hub actually renders:
 *
 *     /api/market/multichain?limit=500  ->  4,934 ms, 698 KB
 *     /api/market/multichain?limit=40   ->  HTTP 504 after 60,081 ms
 *     /api/market/multichain/chain-counts -> 500 after 11,172 ms, then 200 at 4,560 ms
 *
 * The SMALLER page timed out. That is the signature of work that ignores its
 * own limit, and the cause was `COUNT(*) OVER()`: a window aggregate is
 * evaluated over the ENTIRE result set before LIMIT applies, so every request
 * materialised and sorted all ~345,000 joined rows to return forty.
 *
 * What that bought: one integer, for a "showing X of Y" label.
 *
 * The waste compounds in the client. Measured on the same load: 500 rows
 * fetched, 88 cards rendered, and only 12 images actually inside the viewport
 * -- with 54 of 87 images still pending after six seconds. Those are the blank
 * tiles in the owner's screenshot: not broken, starved.
 */

const STORE = readFileSync("lib/market/multichain/store.ts", "utf8").replace(/\r\n/g, "\n");

test("the ranked window no longer counts every row it did not return", () => {
  // The single clause that made a 40-row page slower than a 500-row one.
  //
  // My first version sliced backwards from the FROM clause to the nearest
  // backtick-SELECT and searched only that fragment -- and reinstating
  // COUNT(*) OVER() still PASSED, because the mutation landed outside the
  // window I chose. A mirror, not a check.
  //
  // The clause must not appear anywhere in the EXECUTABLE source. Comments may
  // name it (they explain the bug); code may not contain it.
  const code = STORE.split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
  assert.ok(
    !code.includes("COUNT(*) OVER()"),
    "a window count is evaluated before LIMIT and scans the whole table"
  );
  // A leftover row-type field would mean the query still selects it.
  assert.ok(!code.includes("total_count: string;"), "the row type must not expect a window count");
});

test("the count is a separate, plain aggregate", () => {
  assert.match(STORE, /async function countMatchingCollections/, "the count must have its own query");
  const at = STORE.indexOf("async function countMatchingCollections");
  const body = STORE.slice(at, STORE.indexOf("\n}", at));
  assert.match(body, /SELECT COUNT\(\*\)::text AS n/, "a bare COUNT, not a window");
  assert.ok(!/ORDER BY/.test(body), "counting must not sort");
  assert.ok(!/LIMIT/.test(body), "and must not paginate");
});

test("an unfiltered count does not join snapshots at all", () => {
  // The join is what makes the count expensive. When no clause references
  // snapshots, the count is a single-table aggregate over the catalog.
  const at = STORE.indexOf("async function countMatchingCollections");
  const body = STORE.slice(at, STORE.indexOf("\n}", at));
  assert.match(body, /needsSnapshots = where\.includes\("s\."\)/,
    "the join must be conditional on the filter actually needing it");
  assert.match(body, /needsSnapshots \? "LEFT JOIN/, "and omitted otherwise");
});

test("the count is cached, and the cache cannot grow without bound", () => {
  // A "showing X of Y" label does not need a fresh scan per keystroke. But a
  // map keyed by user-supplied filters is a leak unless it is bounded.
  const at = STORE.indexOf("async function countMatchingCollections");
  const body = STORE.slice(at, STORE.indexOf("\n}", at));
  assert.match(body, /COUNT_TTL_MS/, "the count must be cached");
  assert.match(STORE, /countCache\.size > 200/, "and the cache must be bounded");
  const ttl = STORE.match(/const COUNT_TTL_MS = ([\d_]+);/);
  assert.ok(ttl, "the TTL must be declared");
  const ms = Number(ttl[1]!.replace(/_/g, ""));
  assert.ok(ms > 0 && ms <= 60_000, `a stale-but-cheap total, not a frozen one (saw ${ms} ms)`);
});

/**
 * The pagination rule that makes the total optional rather than load-bearing.
 */
function isLastPage(rowsReturned: number, requested: number): boolean {
  return rowsReturned < requested;
}

test("a short page IS the last page -- no total required", () => {
  // End-of-pagination never needed a full-table count. A page that returns
  // fewer rows than it asked for is terminal by definition.
  assert.equal(isLastPage(12, 40), true, "a short page ends the walk");
  assert.equal(isLastPage(0, 40), true, "an empty page certainly does");
  assert.equal(isLastPage(40, 40), false, "a full page may have more behind it");
});

test("the count query and the page query share the same predicate", () => {
  // If they drift, the label disagrees with the rows and every number on the
  // page becomes untrustworthy -- worse than a slow page.
  const at = STORE.indexOf("const totalCount = await countMatchingCollections");
  assert.ok(at > 0, "the ranked window must call the counter");
  const call = STORE.slice(at, STORE.indexOf(";", at));
  assert.match(call, /whereClauses/, "the same WHERE clauses");
  assert.match(call, /params\.slice\(0, params\.length - 2\)/,
    "and the same params minus the LIMIT/OFFSET pair the count does not use");
});
