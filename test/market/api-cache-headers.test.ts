import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Next applies next.config.ts `headers()` entries AFTER a route handler's own,
 * so a `Cache-Control` set inside a handler is silently discarded by the
 * blanket `/api/:path*` no-store rule. The hub route
 * (app/api/market/multichain/route.ts) documents this overwrite happening in
 * production.
 *
 * The consequence is invisible in code review: the route says
 * `public, s-maxage=10`, the header ships, and the CDN still sees no-store.
 * Four multichain read routes were in that state -- their caching policy was
 * written, deployed, and had never once taken effect.
 *
 * WHAT THIS TEST PINS, AND WHY BOTH DIRECTIONS MATTER
 * ---------------------------------------------------
 * A test that only checked "carved-out routes are cacheable" would pass if
 * someone carved out a route that must NOT be cached. So this asserts both:
 *
 *   1. every route that asks for a positive header on ALL its paths has a
 *      carve-out (otherwise its policy is dead on arrival)
 *   2. routes with MIXED paths, and the hub index, are NOT carved out (a
 *      path-level rule cannot tell a cacheable path from a no-store one)
 *
 * It reads next.config.ts as text rather than importing it, because the config
 * is an ESM module with build-time side effects; the text is the artifact that
 * actually ships.
 */

const CONFIG = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");

/**
 * Every `source:` string in the config, exactly as written.
 *
 * Collected as a set and compared EXACTLY rather than by regex search. The
 * first version of this helper used a substring-ish regex and reported
 * "/api/market/multichain is carved out" because the literal
 * "/api/market/multichain/tokens" contains it as a prefix -- a false positive
 * that would have made the second half of this file assert nothing.
 */
const SOURCES = new Set(
  [...CONFIG.matchAll(/source:\s*["']([^"']+)["']/g)].map((m) => m[1])
);

function hasCarveOut(routePath: string): boolean {
  return SOURCES.has(routePath);
}

test("the blanket /api no-store rule still exists -- this test means nothing without it", () => {
  assert.match(
    CONFIG,
    /source:\s*["']\/api\/:path\*["']/,
    "the blanket rule is the reason carve-outs are needed; if it is gone, revisit every carve-out below"
  );
  assert.match(CONFIG, /no-store, no-cache, must-revalidate, private/);
});

/**
 * Routes whose EVERY success path sets a positive Cache-Control. Without a
 * carve-out their header is overwritten and the policy never applies.
 */
const MUST_BE_CARVED_OUT = [
  "/api/market/multichain/chain-counts",
  "/api/market/multichain/collection-search",
  "/api/market/multichain/token-search",
  // Already carved out before this change; listed so a later cleanup that
  // removes it fails here instead of silently going no-store.
  "/api/market/multichain/feed",
];

for (const route of MUST_BE_CARVED_OUT) {
  test(`${route} is carved out, so its own Cache-Control actually applies`, () => {
    assert.ok(
      hasCarveOut(route),
      `${route} sets a positive Cache-Control in its handler, but next.config.ts has no ` +
        `carve-out for it -- the blanket /api/:path* no-store silently overwrites it and ` +
        `the route's caching policy never takes effect`
    );
  });
}

/**
 * The other direction. These must NOT be carved out.
 *
 * tokens and listings set a positive header on SOME return paths and no-store
 * on others; a path-level carve-out cannot distinguish them and would cache a
 * response the route explicitly marked uncacheable.
 *
 * The hub index (/api/market/multichain) is deliberately NOT in this list: it
 * has carried a public 120s/300s carve-out since the snapshot is precomputed
 * by cron rather than live-fetched. That is a considered decision documented
 * in next.config.ts, not drift.
 */
const MUST_NOT_BE_CARVED_OUT = [
  "/api/market/multichain/tokens",
  "/api/market/multichain/listings",
];

for (const route of MUST_NOT_BE_CARVED_OUT) {
  test(`${route} is NOT carved out -- it has paths that must stay uncacheable`, () => {
    assert.ok(
      !hasCarveOut(route),
      `${route} was carved out of the blanket no-store, but it returns no-store on at least ` +
        `one path. A path-level header rule cannot tell those apart, so this would cache a ` +
        `response the route deliberately marked uncacheable.`
    );
  });
}

test("no carve-out marks a mutable API route immutable", () => {
  // `immutable` is correct for content-addressed media, whose name embeds a
  // sha256 prefix. On anything else it is unrecoverable: a wrong response is
  // pinned in caches for a year with no way to purge a visitor's browser.
  // Scan each `source:` entry against only the text BEFORE the next `source:`,
  // so an `immutable` belonging to a later entry is never attributed to an
  // earlier one. The first version used a fixed 240-character window, which
  // spilled across entry boundaries and blamed "/:path*" for the media rule's
  // immutable -- the same "window ran past the thing it was measuring" mistake
  // this repo has hit before.
  const entries = [...CONFIG.matchAll(/source:\s*["']([^"']+)["']/g)];
  const immutableSources: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const start = entries[i].index ?? 0;
    const end = i + 1 < entries.length ? (entries[i + 1].index ?? CONFIG.length) : CONFIG.length;
    // Match `immutable` only inside a Cache-Control VALUE, never in prose.
    // The word appears in four comments in this file ("an immutable release
    // switch", "immutable is safe and lets audio seek"), and a bare
    // /immutable/ test on the slice reported those as policy.
    if (/value:\s*["'][^"']*immutable[^"']*["']/.test(CONFIG.slice(start, end))) {
      immutableSources.push(entries[i][1]);
    }
  }
  // The allowlist is "what is genuinely content-addressed", not "what happens
  // to be there today":
  //   /api/media/*      -- filename embeds a sha256 prefix
  //   /api/ipfs/*       -- addressed by CID; the bytes cannot change
  //   /plank-social.jpg -- a static social card, versioned by deploy
  const CONTENT_ADDRESSED = /^(\/api\/media\/|\/api\/ipfs\/|\/plank-social\.jpg$)/;
  for (const src of immutableSources) {
    assert.match(
      src,
      CONTENT_ADDRESSED,
      `${src} is marked immutable but is not content-addressed -- a wrong response would be ` +
        `pinned in visitor caches for a year with no way to purge it`
    );
  }
});
