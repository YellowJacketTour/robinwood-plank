import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Silent failures that made a real book render as an empty grid.
 *
 * Measured on production 2026-09-08: Milady Maker's page showed
 * "117 listed of 9,976" in its header and "0 loaded / 117 reported listed"
 * in the grid, with `bookCoverage.sources.opensea = "truncated-at-limit"`.
 * Nothing errored. All three causes are the same species this codebase keeps
 * producing -- a miss indistinguishable from "nothing happened".
 *
 * 1. NEGATIVE SLUG CACHING. resolveOpenSeaCollectionSlug cached `null` in a
 *    Map with no TTL. One transient failure (429, a 15s timeout, a key
 *    rotation) poisoned that collection for the whole process lifetime:
 *    every later call took the cached null, fell back to the raw contract
 *    address as the slug, and 404'd forever.
 *
 * 2. A NULL PAGE REPORTED AS AN EXHAUSTED CURSOR. openSeaFetch returns null
 *    on 404, and `result?.listings ?? []` turned that into an empty page
 *    that the walk reported as `complete: true` -- certifying an empty book
 *    for a collection with 117 live listings.
 *
 * 3. A THROWN PAGE ESCAPING THE WALK. openSeaFetch THROWS on 429/500/timeout
 *    and returns null only on 404, so a rate-limited page propagated to the
 *    route, which rendered a book with no coverage object at all -- measured
 *    live as `bookCoverage: null` with zero listings.
 *
 * These are source-level assertions because the real functions need an
 * OpenSea key and a Postgres pool. The shapes they forbid are exact.
 */

const RAW = readFileSync(
  path.join(process.cwd(), "lib/market/multichain/trading/foreign-orders.ts"),
  "utf8",
);

/**
 * Comments stripped before matching.
 *
 * These fixes DOCUMENT the shapes they forbid, so scanning raw source flags
 * the very comment that explains the fix -- the same self-referential trap as
 * a test fixture built from the constant under test. Match against code only.
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function walkSource(): string {
  const i = SRC.indexOf("export async function fetchForeignAllListingsPaged");
  assert.ok(i > 0, "found the paging walk");
  return SRC.slice(i);
}

test("a failed slug lookup is never cached as identity", () => {
  // The strongest guard is the TYPE, not a pattern: `Map<string, string>`
  // cannot hold a null, so the original bug becomes a compile error rather
  // than a convention someone can drift away from.
  //
  // A line-anchored "forbidden call" check was tried and removed: the FIXED
  // code contains that exact indented call inside its `if (slug) {` block, so
  // the pattern flagged the fix. Same self-referential trap as a fixture built
  // from the constant under test -- the type check has no such ambiguity.
  assert.ok(
    /const slugCache = new Map<string, string>\(\)/.test(SRC),
    "the positive cache must be typed so it CANNOT hold a null",
  );
  assert.ok(
    !/new Map<string,\s*string \| null>/.test(SRC),
    "widening the cache back to string|null reopens the poison pill",
  );
  // And the write must be guarded, so a null never reaches it at runtime.
  assert.ok(
    /if\s*\(slug\)\s*\{[\s\S]{0,200}slugCache\.set\(cacheKey,\s*slug\)/.test(SRC),
    "only a real slug is remembered",
  );
});

test("a failure gets a SHORT expiring memory, not a permanent one", () => {
  // Not caching failure at all would retry OpenSea on every request for a
  // genuinely slug-less contract. Caching it forever was the poison pill.
  const m = /NEGATIVE_SLUG_TTL_MS\s*=\s*([0-9_]+)/.exec(SRC);
  assert.ok(m, "a negative window exists");
  const ttl = Number(m![1]!.replace(/_/g, ""));
  assert.ok(ttl > 0 && ttl <= 5 * 60_000, `negative TTL must be short, got ${ttl}ms`);
  assert.ok(
    /Date\.now\(\)\s*-\s*missedAt\s*<\s*NEGATIVE_SLUG_TTL_MS/.test(SRC),
    "the miss must EXPIRE, so a collection heals by itself after an outage",
  );
  assert.ok(
    /slugMisses\.delete\(cacheKey\)/.test(SRC),
    "a later success must clear the miss rather than leaving it to age out",
  );
});

test("a null page ends the walk as INCOMPLETE, never as a complete book", () => {
  const walk = walkSource();
  // The bug: `result?.listings ?? []` made a null page look like an empty
  // page, and an empty page returns complete: true.
  assert.ok(
    !/\(result\?\.listings\s*\?\?\s*\[\]\)\.length\s*===\s*0/.test(walk),
    "a null page must be distinguished from a genuinely empty page",
  );
  assert.ok(
    /if\s*\(result\s*==\s*null\)\s*return\s*\{\s*orders,\s*complete:\s*false/.test(walk),
    "a null page (404) must report an INCOMPLETE book",
  );
});

test("a transport miss mid-walk is not an end of book", () => {
  const walk = walkSource();

  // Isolate the catch block and read ITS return, rather than searching a
  // window after `catch {`. Mutation-tested: a `[\s\S]{0,400}` window ran
  // past the block and matched a LATER `complete: false`, so flipping the
  // catch to `complete: true` still passed. A guard that can be satisfied by
  // code it is not inspecting is a mirror, not a check.
  const at = walk.indexOf("} catch {");
  assert.ok(at > 0, "the walk catches its own page failures");
  const body = walk.slice(at, walk.indexOf("}", walk.indexOf("return", at)));

  assert.ok(
    /return\s*\{\s*orders,\s*complete:\s*false/.test(body),
    "a thrown page (429/500/timeout) must report an INCOMPLETE book, not escape the walk",
  );
  assert.ok(
    !/complete:\s*true/.test(body),
    "a transport failure can never certify a complete book",
  );
});

test("the walk still reports complete when the cursor genuinely ends", () => {
  const walk = walkSource();
  // The honest completion path must survive: a real exhausted cursor IS a
  // complete book, and over-reporting partial would be its own lie.
  assert.ok(
    /if\s*\(!cursor\s*\|\|\s*result\.listings\.length\s*===\s*0\)\s*return\s*\{\s*orders,\s*complete:\s*true/.test(walk),
    "an exhausted cursor is a genuinely complete book",
  );
});

test("openSeaFetch's null-on-404 contract is what makes these rules necessary", () => {
  // If this ever changes to throw, the guards above become dead code rather
  // than silently wrong -- so pin the contract they depend on.
  assert.ok(
    /if\s*\(res\.status\s*===\s*404\)\s*return\s*null/.test(SRC),
    "openSeaFetch returns null on 404; every caller must treat null as 'unknown', not 'empty'",
  );
});
