import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * THE BOOK HAD AN UNREACHABLE TAIL.
 *
 * fetchForeignAllListingsPaged walked OpenSea's `next` cursor, used it
 * internally on every page -- and then DISCARDED it at return. Its shape was
 * `{ orders, complete, pages }`. Combined with a hard `pages < 25` budget and
 * `Math.min(input.limit ?? 100, 1_000)`, a collection with more distinct
 * listed tokens than one call could gather had listings that NO REQUEST COULD
 * EVER REACH -- not with a different limit, not at a different URL.
 *
 * `complete: false` reported the truncation honestly, which made it visible
 * but not recoverable. Honest and useless is still useless.
 *
 * The owner's rule is that throughput is never capped arbitrarily; the only
 * allowable limits pace a process so it does not expire. A page budget is
 * legitimate pacing -- it keeps one request inside its deadline and inside
 * OpenSea's per-key quota. What made it a CEILING was throwing the cursor
 * away, so stopping meant losing.
 *
 * Returning `nextCursor` converts it: the walk still stops, but the caller
 * continues from exactly where it stopped.
 *
 * WHAT IS TESTED
 * --------------
 * The cursor contract is pure control flow, so it is driven directly against a
 * fake page source. The wiring (route accepts ?cursor, route returns
 * nextCursor, my-listings walks to exhaustion) is asserted against source
 * text -- weaker, but a regression that silently restores the dead end is
 * invisible otherwise.
 */

const ORDERS_SRC = readFileSync(
  new URL("../../lib/market/multichain/trading/foreign-orders.ts", import.meta.url),
  "utf8"
);
const LISTINGS_SRC = readFileSync(
  new URL("../../app/api/market/multichain/listings/route.ts", import.meta.url),
  "utf8"
);
const MINE_SRC = readFileSync(
  new URL("../../app/api/market/multichain/my-listings/route.ts", import.meta.url),
  "utf8"
);

// --- the cursor contract, driven ------------------------------------------

type Page = { ids: string[]; next: string | null };

/**
 * The exact stopping rule the walk implements, isolated so its behaviour can
 * be driven without a network. Mirrors: gather distinct ids until `target`,
 * stop after `pagesPerCall`, return whatever cursor is still pending.
 */
function walk(
  pages: Map<string | null, Page>,
  opts: { target: number; pagesPerCall: number; cursor?: string | null }
): { ids: string[]; complete: boolean; nextCursor: string | null } {
  const distinct = new Set<string>();
  let cursor: string | null = opts.cursor ?? null;
  let walked = 0;
  while (distinct.size < opts.target && walked < opts.pagesPerCall) {
    const page = pages.get(cursor);
    if (!page) return { ids: [...distinct], complete: false, nextCursor: cursor };
    walked += 1;
    for (const id of page.ids) distinct.add(id);
    cursor = page.next;
    if (!cursor || page.ids.length === 0) return { ids: [...distinct], complete: true, nextCursor: null };
  }
  return { ids: [...distinct], complete: cursor == null, nextCursor: cursor };
}

/** A book of `total` tokens, 2 per page -- deliberately more pages than one call walks. */
function book(total: number): Map<string | null, Page> {
  const pages = new Map<string | null, Page>();
  for (let i = 0; i < total; i += 2) {
    const key = i === 0 ? null : `cur${i}`;
    const next = i + 2 < total ? `cur${i + 2}` : null;
    pages.set(key, { ids: [String(i), String(i + 1)], next });
  }
  return pages;
}

test("a walk that stops on its page budget hands back a usable cursor", () => {
  const pages = book(100);
  const first = walk(pages, { target: 1_000, pagesPerCall: 3 });
  assert.equal(first.complete, false, "50 pages of book cannot be complete after 3");
  assert.ok(first.nextCursor, "stopping on the page budget must return where to resume");
  assert.equal(first.ids.length, 6, "3 pages x 2 ids");
});

/**
 * THE REGRESSION TEST. Before the fix this was impossible: token #99 could not
 * be reached by any sequence of calls.
 */
test("repeated calls with the returned cursor reach the END of the book", () => {
  const pages = book(100);
  const seen = new Set<string>();
  let cursor: string | null = null;
  let calls = 0;
  for (;;) {
    const page = walk(pages, { target: 1_000, pagesPerCall: 3, cursor });
    for (const id of page.ids) seen.add(id);
    cursor = page.nextCursor;
    calls += 1;
    if (!cursor) break;
    assert.ok(calls < 100, "the walk must terminate, not spin");
  }
  assert.equal(seen.size, 100, "every token in the book is reachable across calls");
  assert.ok(seen.has("99"), "including the last one, which no single call could reach");
  assert.ok(calls > 1, "and it genuinely took more than one call -- otherwise this proves nothing");
});

test("an exhausted cursor returns null, so a caller knows to stop", () => {
  const pages = book(4);
  const page = walk(pages, { target: 1_000, pagesPerCall: 10 });
  assert.equal(page.complete, true);
  assert.equal(page.nextCursor, null, "null is the ONLY honest value for a finished book");
});

test("a failed page returns the cursor that would retry it, not null", () => {
  const pages = book(100);
  pages.delete("cur4"); // page 3 is unreachable, as a 429 or 404 would be
  const page = walk(pages, { target: 1_000, pagesPerCall: 10 });
  assert.equal(page.complete, false, "a failure is not an exhausted book");
  assert.equal(page.nextCursor, "cur4", "a transient failure must not cost the caller its place");
});

// --- the wiring ------------------------------------------------------------

test("the page budget is a named pacing constant, not an inline magic number", () => {
  assert.match(
    ORDERS_SRC,
    /export const PAGES_PER_CALL = \d+/,
    "the bound must be named and documented as pacing"
  );
  assert.match(ORDERS_SRC, /pages < PAGES_PER_CALL/, "and actually used by the walk");
});

test("no invented ceiling remains on what a caller may request", () => {
  const fn = /export async function fetchForeignAllListingsPaged[\s\S]*?\n\}/.exec(ORDERS_SRC)?.[0] ?? "";
  assert.ok(fn.length > 0, "the function must be locatable");
  assert.doesNotMatch(
    fn,
    /Math\.min\(input\.limit/,
    "clamping the caller's target to an invented maximum is the ceiling this change removed"
  );
});

/**
 * THE MUTATION THIS FILE FIRST MISSED.
 *
 * The driven tests above exercise a local mirror of the stopping rule, so they
 * verify the CONTRACT but cannot see the real function -- changing
 * `nextCursor: cursor` to `nextCursor: null` on the budget exit left all of
 * them green. That is the "the test is a mirror of the code" trap, and it is
 * the exact failure this file exists to prevent elsewhere.
 *
 * This asserts the real source: the exit that stops on the page budget must
 * hand back the pending cursor, because that exit IS the former dead end.
 */
test("the page-budget exit returns the pending cursor, not null", () => {
  const budgetExit = /\n  return \{ orders, complete: cursor == null, pages, nextCursor: ([^ }]+) \};/.exec(ORDERS_SRC);
  assert.ok(budgetExit, "the walk's final return must be locatable");
  assert.equal(
    budgetExit[1],
    "cursor",
    "returning null here recreates the unreachable tail: the walk stops with book " +
      "behind it and tells the caller there is nothing to resume"
  );
});

test("every return from the walk carries a cursor", () => {
  // Matched across the whole module rather than by extracting the function:
  // a `[\s\S]*?\n\}` extraction stops at the first nested closing brace, which
  // silently truncated this scan to the first two returns and made the
  // assertion weaker than it looked. `return { orders` is unique to this walk.
  const returns = [...ORDERS_SRC.matchAll(/return \{ orders[^;]*\};/g)].map((m) => m[0]);
  assert.equal(
    returns.length,
    5,
    `the walk has five exits (no-orderbook, fetch-threw, null-page, exhausted, budget); found ${returns.length}`
  );
  for (const r of returns) {
    assert.match(r, /nextCursor/, `a return without nextCursor is a dead end: ${r}`);
  }
});

test("the listings route accepts a cursor and returns the next one", () => {
  assert.match(
    LISTINGS_SRC,
    /cursor: searchParams\.get\("cursor"\)/,
    "without accepting ?cursor the walk always restarts at page one"
  );
  assert.match(
    LISTINGS_SRC,
    /nextCursor: paged\.nextCursor/,
    "without returning it the client cannot continue"
  );
});

test("my-listings walks to exhaustion instead of filtering after a truncation", () => {
  assert.doesNotMatch(
    MINE_SRC,
    /limit: 50/,
    "fetching 50 distinct tokens and THEN filtering by maker made a seller's own " +
      "listings vanish when they sat deeper in the book"
  );
  assert.match(MINE_SRC, /fetchForeignAllListingsPaged/, "it must use the paged walk");
  assert.match(MINE_SRC, /cursor = page\.nextCursor/, "and follow the cursor");
  assert.match(MINE_SRC, /if \(!cursor\) break;/, "and terminate when it is exhausted");
});
