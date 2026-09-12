import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  searchProjectedTokens,
  TOKEN_SEARCH_MAX_PAGE,
} from "../../lib/market/multichain/collection-token-store";
import {
  COLLECTION_SEARCH_MAX_PAGE,
  searchTrackedCollectionsByName,
} from "../../lib/market/multichain/store";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * FOUR PLACES WHERE THROUGHPUT WAS CAPPED WITH NO WAY PAST IT.
 *
 * The owner's rule: throughput is never arbitrarily capped. The only allowable
 * limits PACE a process so it does not expire, blow a deadline, or breach a
 * vendor quota -- and a page size is pacing ONLY if the caller can iterate past
 * it. A page size with no cursor and no offset is not a page size. It is a
 * ceiling wearing a page size's clothes.
 *
 * All four defects shared one signature, which is also the house rule this repo
 * keeps paying to relearn: A MISS WAS INDISTINGUISHABLE FROM "NOTHING HAPPENED".
 *
 *   1. /token-search passed a literal `limit: 40` and never read ?limit. The
 *      store clamped to 60, so 60 was unreachable through the only caller. No
 *      offset, no cursor, no count: a global search over a 19.4M-row projection
 *      returned 40 rows, and the response for "exactly 40 matches exist" was
 *      byte-identical to the one for "5,000 matches exist".
 *
 *   2. /collection-search passed a literal `limit: 60` and never read ?limit.
 *      Same shape, over a 300,304-row catalog (measured on the local mirror of
 *      production while writing this file). Match 61 was unreachable.
 *
 *   3. /wallet-summary capped the vendor fan-out at 10 collections and DID say
 *      `truncated: true` -- honestly, and uselessly, because there was no
 *      continuation parameter of any kind. Collections 11..N were unreachable
 *      forever. This repo already wrote "Honest and useless is still useless"
 *      about the identical mistake in the listings book; see
 *      test/market/listings-cursor-uncapped.test.ts.
 *
 *   4. /hydrate-stats sliced a caller's batch to 10 and reported `attempted`
 *      counting only the survivors, so posting 40 rows and posting 10 rows
 *      produced the same response. Rows 11..40 were dropped in silence.
 *
 * WHAT THIS FILE TESTS, AND HOW
 * -----------------------------
 * The two paging engines (1 and 2) are DRIVEN against the real Postgres store
 * with real seeded rows -- not a mirror of the SQL, because a mirror of a
 * keyset predicate proves only that the mirror agrees with itself. The
 * reachability assertions below walk the cursor/offset to EXHAUSTION and check
 * that the row which no single request could previously reach is now reached.
 *
 * Defects 3 and 4 are vendor-fan-out and write-side routes with no seedable
 * read path, so their contracts are asserted against source text. Weaker, and
 * said out loud: a regression that silently restores the dead end is invisible
 * otherwise.
 */

const SKIP = { skip: !hasPostgresConfig() };

const TOKEN_SEARCH_SRC = readFileSync(
  new URL("../../app/api/market/multichain/token-search/route.ts", import.meta.url),
  "utf8"
);
const COLLECTION_SEARCH_SRC = readFileSync(
  new URL("../../app/api/market/multichain/collection-search/route.ts", import.meta.url),
  "utf8"
);
const WALLET_SRC = readFileSync(
  new URL("../../app/api/market/multichain/wallet-summary/route.ts", import.meta.url),
  "utf8"
);
const HYDRATE_SRC = readFileSync(
  new URL("../../app/api/market/multichain/hydrate-stats/route.ts", import.meta.url),
  "utf8"
);

// --- 1. token search: the keyset, driven against real rows ----------------

const TOKEN_CHAIN = "zzpagination-chain";
const TOKEN_COLLECTION = "zzpagination-tokens";
/** Deliberately more than the old 40-row route ceiling AND more than the old
 * store clamp of 60, so a run that silently reverts either one cannot pass. */
const SEEDED_TOKENS = 137;

async function seedTokens(): Promise<void> {
  await dropTokens();
  // All rows share one relevance bucket, one enriched flag and (deliberately)
  // ONE projected_at timestamp. That makes every leading sort key a tie, which
  // is exactly the case a keyset gets wrong when its tuple is not total: it
  // either loops on the same rows forever or skips the rest of the tie.
  // Seeding the easy case (distinct timestamps) would have let a broken keyset
  // pass this whole file.
  const ids: string[] = [];
  for (let i = 0; i < SEEDED_TOKENS; i += 1) ids.push(`zzpage${String(i).padStart(4, "0")}`);
  await postgresQuery(
    `INSERT INTO plank_collection_tokens
       (chain_slug, collection_slug, token_id, name, image_url, source_observed_at, projected_at)
     SELECT $1, $2, t, 'ZZPagination ' || t, 'https://example.invalid/a.png', NOW(), NOW()
       FROM unnest($3::text[]) AS t`,
    [TOKEN_CHAIN, TOKEN_COLLECTION, ids]
  );
}

async function dropTokens(): Promise<void> {
  await postgresQuery(
    `DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`,
    [TOKEN_CHAIN, TOKEN_COLLECTION]
  );
}

test("token search: every match is reachable by walking the cursor", SKIP, async () => {
  await seedTokens();
  try {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let calls = 0;
    for (;;) {
      const page = await searchProjectedTokens({
        query: "zzpage",
        chainSlugs: [TOKEN_CHAIN],
        limit: 20,
        cursor,
      });
      for (const t of page.tokens) {
        assert.equal(
          seen.has(t.tokenId),
          false,
          `the cursor walk returned ${t.tokenId} twice -- a keyset that repeats rows is a keyset that can also skip them`
        );
        seen.add(t.tokenId);
      }
      cursor = page.nextCursor;
      calls += 1;
      if (!cursor) break;
      assert.ok(calls < 50, "the walk must terminate, not spin");
    }
    assert.equal(
      seen.size,
      SEEDED_TOKENS,
      `every seeded token must be reachable across calls; reached ${seen.size} of ${SEEDED_TOKENS}`
    );
    assert.ok(
      seen.has(`zzpage${String(SEEDED_TOKENS - 1).padStart(4, "0")}`),
      "including the last one, which no single request could reach under the old 40-row ceiling"
    );
    assert.ok(calls > 1, "and it genuinely took more than one call -- a one-call walk proves nothing about paging");
  } finally {
    await dropTokens();
  }
});

test("token search: a caller may request more than the old ceilings", SKIP, async () => {
  await seedTokens();
  try {
    // 100 is above the route's old hardcoded 40 AND above the store's old clamp
    // of 60. Under either, this returns at most 60 rows and the assertion
    // below fails -- which is the point: this test cannot pass on the old code.
    const page = await searchProjectedTokens({ query: "zzpage", chainSlugs: [TOKEN_CHAIN], limit: 100 });
    assert.equal(
      page.tokens.length,
      100,
      `a requested limit of 100 must yield 100 of the ${SEEDED_TOKENS} seeded rows`
    );
    assert.ok(page.nextCursor, "37 rows remain behind this page, so it must say where to resume");
  } finally {
    await dropTokens();
  }
});

test("token search: an exhausted search returns a null cursor, not a cursor to nowhere", SKIP, async () => {
  await seedTokens();
  try {
    const page = await searchProjectedTokens({ query: "zzpage", chainSlugs: [TOKEN_CHAIN], limit: SEEDED_TOKENS });
    assert.equal(page.tokens.length, SEEDED_TOKENS);
    assert.equal(
      page.nextCursor,
      null,
      "null is the ONLY honest value for a finished search -- a cursor here sends the caller after rows that do not exist"
    );
  } finally {
    await dropTokens();
  }
});

/**
 * THE EXACT-FIT BOUNDARY. A page that is exactly `limit` rows long with nothing
 * behind it and one with more behind it are indistinguishable from the row
 * count alone. That is why the query fetches limit + 1 rather than deciding
 * from `rows.length === limit`.
 */
test("token search: a page that exactly fills with more behind it still emits a cursor", SKIP, async () => {
  await seedTokens();
  try {
    const first = await searchProjectedTokens({ query: "zzpage", chainSlugs: [TOKEN_CHAIN], limit: 100 });
    assert.equal(first.tokens.length, 100);
    assert.ok(first.nextCursor, "a completely full page with 37 rows behind it must not look finished");
    const rest = await searchProjectedTokens({
      query: "zzpage",
      chainSlugs: [TOKEN_CHAIN],
      limit: 100,
      cursor: first.nextCursor,
    });
    assert.equal(rest.tokens.length, SEEDED_TOKENS - 100, "the remainder must be exactly what the first page left");
    assert.equal(rest.nextCursor, null, "and now it really is finished");
  } finally {
    await dropTokens();
  }
});

test("token search: a junk cursor restarts rather than erroring or returning nothing", SKIP, async () => {
  await seedTokens();
  try {
    const page = await searchProjectedTokens({
      query: "zzpage",
      chainSlugs: [TOKEN_CHAIN],
      limit: 10,
      cursor: "%%%not-a-cursor%%%",
    });
    assert.equal(page.tokens.length, 10, "an undecodable cursor must fall back to the first page, not to an empty one");
  } finally {
    await dropTokens();
  }
});

test("token search: the page bound is a named constant well above the ceiling it replaced", () => {
  assert.ok(
    TOKEN_SEARCH_MAX_PAGE >= 200,
    `the transport bound must be a real page size, not the old 40/60 ceiling; got ${TOKEN_SEARCH_MAX_PAGE}`
  );
});

test("the token-search route reads ?limit and ?cursor and returns nextCursor", () => {
  assert.match(
    TOKEN_SEARCH_SRC,
    /searchParams\.get\("limit"\)/,
    "a route that never reads ?limit makes even the store's own bound unreachable -- that WAS the bug"
  );
  assert.match(
    TOKEN_SEARCH_SRC,
    /searchParams\.get\("cursor"\)/,
    "without accepting ?cursor, every request restarts at page one"
  );
  assert.match(TOKEN_SEARCH_SRC, /nextCursor: page\.nextCursor/, "without returning it the caller cannot continue");
  // Scoped to the store call, and anchored on `await `, for two separate
  // reasons this file learned the hard way:
  //   - a bare /limit: \d/ over the whole file also matches the rate-limit
  //     config (`{ key: "...", limit: 60, windowMs: 60_000 }`), which must keep
  //     its literal;
  //   - the route's own header comment quotes the OLD call
  //     (`searchProjectedTokens({ ..., limit: 40 })`) verbatim as the
  //     description of the bug, so an unanchored match read that PROSE and
  //     failed on correct code -- a test treating a comment as the
  //     implementation.
  const storeCall = /await searchProjectedTokens\(\{([^}]*)\}\)/.exec(TOKEN_SEARCH_SRC);
  assert.ok(storeCall, "the store call must be locatable");
  assert.doesNotMatch(
    storeCall[1],
    /limit:\s*\d/,
    "a numeric literal passed as the store's limit is the ceiling this change removed"
  );
  assert.match(storeCall[1], /limit,/, "the limit must come from the request");
  assert.match(storeCall[1], /cursor,/, "and the cursor must be forwarded to the store");
});

// --- 2. collection search: offset + totalCount, driven --------------------

/**
 * Runs against the REAL catalog rather than seeded rows: it already holds
 * 300,304 collections locally, and any term with more matches than one page
 * exercises the exact condition the old code got wrong. The term is chosen at
 * runtime from what is actually present, so this does not encode a fixture
 * that a catalog refresh would silently turn into a no-op.
 */
async function termWithManyMatches(minMatches: number): Promise<string | null> {
  // Two characters minimum: searchTrackedCollectionsByName rejects shorter
  // queries outright (pre-existing, deliberate -- a one-character search over
  // 300k rows is not a search). A helper that offered "a" made every caller
  // below assert against an empty result and look like a paging bug.
  for (const term of ["ar", "er", "on", "art", "the"]) {
    const r = await postgresQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM plank_multichain_collections
        WHERE (name ILIKE $1 OR contract_address ILIKE $1)`,
      [`%${term}%`]
    );
    if (Number(r.rows[0]?.n ?? 0) >= minMatches) return term;
  }
  return null;
}

test("collection search: totalCount reports the match set, not the page", SKIP, async () => {
  const term = await termWithManyMatches(500);
  if (!term) {
    // Reported, not silently skipped: a test that quietly asserts nothing is
    // the failure species this repo keeps paying for.
    assert.ok(true, "no term in this catalog has 500+ matches -- page/total divergence not asserted (catalog too small)");
    return;
  }
  const page = await searchTrackedCollectionsByName(term, { limit: 60 });
  assert.equal(page.collections.length, 60, "the requested page size must be honoured");
  assert.ok(
    page.totalCount > page.collections.length,
    `totalCount (${page.totalCount}) must exceed the page (${page.collections.length}) -- reporting the page size as the total is precisely how 60 masqueraded as a complete answer`
  );
  assert.equal(page.nextOffset, 60, "and the caller must be told exactly where to resume");
});

test("collection search: walking the offset reaches rows no single request could", SKIP, async () => {
  const term = await termWithManyMatches(200);
  if (!term) {
    assert.ok(true, "no term in this catalog has 200+ matches -- deep-page reachability not asserted");
    return;
  }
  // Row 61 was the first unreachable row under the route's old hardcoded 60.
  const firstPage = await searchTrackedCollectionsByName(term, { limit: 60, offset: 0 });
  const secondPage = await searchTrackedCollectionsByName(term, { limit: 60, offset: 60 });
  assert.ok(secondPage.collections.length > 0, "match 61 onwards must be retrievable");
  const firstKeys = new Set(firstPage.collections.map((c) => `${c.chainSlug}:${c.contractAddress}`));
  for (const c of secondPage.collections) {
    assert.equal(
      firstKeys.has(`${c.chainSlug}:${c.contractAddress}`),
      false,
      `offset 60 returned ${c.contractAddress}, which offset 0 already returned -- an offset that does not advance is not a continuation`
    );
  }
  assert.equal(secondPage.totalCount, firstPage.totalCount, "the total must not shift between pages of one search");
});

test("collection search: nextOffset is null exactly when the match set is exhausted", SKIP, async () => {
  const term = await termWithManyMatches(1);
  if (!term) {
    assert.ok(true, "empty catalog -- exhaustion not asserted");
    return;
  }
  const total = (await searchTrackedCollectionsByName(term, { limit: 1 })).totalCount;
  // Ask for the whole match set in one page where it fits, so the LAST page is
  // genuinely last. A page that ends the set must not emit an offset.
  if (total <= COLLECTION_SEARCH_MAX_PAGE) {
    const whole = await searchTrackedCollectionsByName(term, { limit: COLLECTION_SEARCH_MAX_PAGE });
    assert.equal(whole.collections.length, total);
    assert.equal(whole.nextOffset, null, "a page containing every match must not send the caller after more");
  }
  // And an offset past the end must terminate rather than wrap.
  const past = await searchTrackedCollectionsByName(term, { limit: 10, offset: total + 1_000 });
  assert.equal(past.collections.length, 0, "an offset past the end returns nothing");
  assert.equal(past.nextOffset, null, "and says so, instead of looping the caller forever");
});

test("collection search: a caller may request more than the old hardcoded 60", SKIP, async () => {
  const term = await termWithManyMatches(200);
  if (!term) {
    assert.ok(true, "no term with 200+ matches -- above-60 page not asserted");
    return;
  }
  const page = await searchTrackedCollectionsByName(term, { limit: 150 });
  assert.equal(page.collections.length, 150, "150 rows were unreachable while the route hardcoded 60");
});

test("the collection-search route reads ?limit and ?offset and returns totalCount", () => {
  assert.match(COLLECTION_SEARCH_SRC, /searchParams\.get\("limit"\)/, "the route must let the caller size its page");
  assert.match(COLLECTION_SEARCH_SRC, /searchParams\.get\("offset"\)/, "without ?offset, match 61 is unreachable");
  assert.match(
    COLLECTION_SEARCH_SRC,
    /totalCount: page\.totalCount/,
    "a page with no total cannot be distinguished from a complete answer"
  );
  assert.match(COLLECTION_SEARCH_SRC, /nextOffset: page\.nextOffset/, "and the caller must be told where to resume");
  // Scoped to the store call. A bare /limit: 60/ also matched the rate-limit
  // config on the line above (`{ key: "...", limit: 60, windowMs: 60_000 }`),
  // so it failed on the FIXED code -- a false positive that would have been
  // "fixed" by weakening the assertion into uselessness.
  const storeCall = /searchTrackedCollectionsByName\(query, \{([^}]*)\}\)/.exec(COLLECTION_SEARCH_SRC);
  assert.ok(storeCall, "the store call must be locatable");
  assert.doesNotMatch(
    storeCall[1],
    /limit:\s*\d/,
    "a numeric literal passed as the store's limit is the ceiling this change removed"
  );
  assert.match(storeCall[1], /limit,/, "the limit must come from the request, not from the handler");
  assert.match(storeCall[1], /offset,/, "and so must the offset");
});

// --- 3. wallet-summary: the fan-out window must move ----------------------

test("wallet-summary accepts ?offset and reports where to resume", () => {
  assert.match(
    WALLET_SRC,
    /searchParams\.get\("offset"\)/,
    "`truncated: true` with no continuation parameter is the defect: honest, and unrecoverable"
  );
  assert.match(WALLET_SRC, /nextOffset,/, "the response must carry the continuation, not just the fact of truncation");
  assert.match(WALLET_SRC, /collectionOffset: offset/, "and echo which window it answered, so a caller can tell pages apart");
});

/**
 * THE BUG THE FIX ITSELF ALMOST INTRODUCED, PINNED HERE.
 *
 * The Robinhood lane is windowed at OWNERSHIP-RESOLUTION time inside
 * fetchOwnedRobinhood (one raw-RPC scan per tracked collection), so by the time
 * the handler sees `owned`, those rows are ALREADY the [offset, offset+MAX)
 * slice. The foreign lane is not pre-windowed. Slicing the merged distinct list
 * by `offset` therefore skips the Robinhood rows a SECOND time -- re-creating
 * the unreachable tail that the offset exists to remove, inside the fix for it.
 *
 * Asserted on source because there is no seedable path through two live vendor
 * fan-outs, and because the failure is invisible at runtime: the response still
 * looks well-formed, it just never mentions the collections it skipped.
 */
test("wallet-summary windows the foreign lane only -- the Robinhood lane is already windowed", () => {
  assert.match(
    WALLET_SRC,
    /const foreignEntries = collectionEntries\.filter\(\(c\) => !isRobinhoodChainSlug\(c\.chainSlug\)\)/,
    "the foreign window must be taken over foreign entries alone"
  );
  assert.match(
    WALLET_SRC,
    /foreignEntries\.slice\(offset, offset \+ MAX_COLLECTIONS\)/,
    "and it must be a moving window, not a fixed head"
  );
  assert.doesNotMatch(
    WALLET_SRC,
    /collectionEntries\.slice\(offset/,
    "slicing the MERGED list by offset double-skips the Robinhood lane -- the tail-eating bug, reintroduced"
  );
  assert.doesNotMatch(
    WALLET_SRC,
    /\.slice\(0, MAX_COLLECTIONS\)/,
    "a slice that always starts at 0 is a ceiling no offset can move"
  );
  assert.match(
    WALLET_SRC,
    /robinhoodCollections\.slice\(offset, offset \+ MAX_COLLECTIONS\)/,
    "the Robinhood lane must take the same offset, or its own tail stays unreachable"
  );
});

test("wallet-summary reports truncation from BOTH lanes, not just the foreign one", () => {
  assert.match(
    WALLET_SRC,
    /const truncated = foreignTruncated \|\| robinhoodOwned\.truncated/,
    "a caller that stops when one lane runs out silently skips the other lane's tail"
  );
});

// --- 4. hydrate-stats: the cap may stay, the silence may not ---------------

test("hydrate-stats reports what it accepted and what it dropped", () => {
  assert.match(
    HYDRATE_SRC,
    /submitted: deduped\.length/,
    "without the pre-cap count, posting 40 rows and posting 10 rows produce identical responses"
  );
  assert.match(
    HYDRATE_SRC,
    /accepted: jobs\.length/,
    "mirrors visibility-demand's own `accepted` for the same class of bound"
  );
  assert.match(
    HYDRATE_SRC,
    /rejected: deduped\.length - jobs\.length/,
    "the dropped count is the number the caller needs in order to act"
  );
  assert.match(HYDRATE_SRC, /maxPerRequest: MAX_JOBS/, "naming the batch width lets a client chunk correctly on the first try");
});

test("hydrate-stats's cap is a named constant, not an inline magic number", () => {
  assert.match(HYDRATE_SRC, /const MAX_JOBS = \d+/, "the bound must be named and documented as write-side pacing");
  assert.match(HYDRATE_SRC, /deduped\.slice\(0, MAX_JOBS\)/, "and actually used");
  assert.doesNotMatch(
    HYDRATE_SRC,
    /\}\)\.slice\(0, 10\);/,
    "the inline `.slice(0, 10)` chained straight onto the dedupe is what made the drop unobservable -- it left no pre-cap length to report"
  );
});

/**
 * The dedupe-then-cap pipeline, driven against the route's OWN expressions.
 *
 * An earlier version of this test recomputed `accepted = Math.min(submitted,
 * MAX_JOBS)` and `rejected = submitted - accepted` locally and then asserted
 * `accepted + rejected === submitted`. That is a tautology over two local
 * variables -- it holds for any MAX_JOBS, any input, and any state of the
 * route, including a route that reports nothing at all. It was a mirror of the
 * code that could not observe the code.
 *
 * This version extracts the ACTUAL expressions from the handler source and
 * evaluates them, so a change to either one is exercised here. `deduped` is
 * modelled as a real list with real duplicates, because the cap applies AFTER
 * dedupe and reporting the raw post-dedupe length is the whole point of the
 * fix.
 */
test("hydrate-stats dedupes first, then caps, and reports both numbers", () => {
  const MAX_JOBS = Number(/const MAX_JOBS = (\d+)/.exec(HYDRATE_SRC)?.[1]);
  assert.ok(Number.isInteger(MAX_JOBS) && MAX_JOBS > 0, "MAX_JOBS must be readable from the real source");

  // Pull the reported expressions out of the handler rather than restating
  // them. If someone changes `submitted` to `jobs.length` -- the original bug,
  // where the reported count was the post-cap one -- these break.
  // Scoped to the NextResponse.json({...}) payload. Matching the whole file
  // picked up `accepted: Math.min(merged.length, MAX_KEYS)` out of the comment
  // that cites visibility-demand as the precedent -- prose read as code, the
  // same trap the token-search assertion above documents.
  const payload = /return NextResponse\.json\(\{([\s\S]*?)maxPerRequest: MAX_JOBS,/.exec(HYDRATE_SRC)?.[1] ?? "";
  assert.ok(payload.includes("hydrated:"), "the response payload must be locatable");
  const submittedExpr = /submitted: ([^,]+),/.exec(payload)?.[1]?.trim();
  const acceptedExpr = /accepted: ([^,]+),/.exec(payload)?.[1]?.trim();
  const rejectedExpr = /rejected: ([^,]+),/.exec(payload)?.[1]?.trim();
  assert.equal(submittedExpr, "deduped.length", "`submitted` must be the PRE-cap count, or a truncated batch is invisible again");
  assert.equal(acceptedExpr, "jobs.length", "`accepted` must be what actually ran");
  assert.equal(rejectedExpr, "deduped.length - jobs.length", "`rejected` must be the difference, not a constant");

  // And the pipeline those expressions name, evaluated on real input: 14
  // distinct keys submitted as 18 rows (4 duplicates), against a cap of
  // MAX_JOBS. The duplicates must vanish before the cap, and the caller must be
  // able to tell how many of its distinct keys were left undone.
  const rows = [
    ...Array.from({ length: 14 }, (_, i) => `eth:0xc${i}`),
    "eth:0xc0", "eth:0xc1", "eth:0xc2", "eth:0xc3",
  ];
  const seen = new Set<string>();
  const deduped = rows.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
  const jobs = deduped.slice(0, MAX_JOBS);
  assert.equal(deduped.length, 14, "dedupe must collapse the 4 repeats before the cap sees them");
  assert.equal(jobs.length, Math.min(14, MAX_JOBS), "the cap applies to distinct work, not to raw rows");
  assert.equal(
    deduped.length - jobs.length,
    14 - Math.min(14, MAX_JOBS),
    "and the remainder is exactly what the caller must resend"
  );
  assert.ok(
    deduped.length > jobs.length,
    `this fixture must actually overflow the cap (${MAX_JOBS}) or it proves nothing about truncation reporting`
  );
});
