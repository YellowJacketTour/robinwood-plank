import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  planArtLookups,
  distinctTokenIds,
  mapWithConcurrency,
  MAX_REMOTE_ART_LOOKUPS,
  ART_RPC_DEADLINE_MS,
  MAX_CONCURRENT_ART_RPC,
} from "../../lib/market/multichain/art-lookup-plan";

/**
 * THREE ROUTES CAPPED THROUGHPUT WHERE THEY MEANT TO PACE A VENDOR.
 *
 * listings, offers and owned each resolved per-token art by taking the
 * distinct token ids and doing `.slice(0, 30)`. Everything past the
 * thirtieth rendered with null/undefined name and image, and no response
 * field said so. For an NFT surface that is a blank tile indistinguishable
 * from a broken image, a dead CDN, or a token with genuinely no art.
 *
 * The 30 was a correct number in the wrong place. It was written when art
 * resolution meant one cold OpenSea HTTP call per token; thirty of those on
 * a page render IS a real hazard and bounding it IS legitimate pacing. What
 * changed underneath it (listings, 2026-09-08) was the archive-first read:
 * readProjectedTokensByIds is ONE indexed `token_id = ANY($3)` query against
 * plank_collection_tokens, costing the same whether the array holds 5 ids or
 * 5,000, and bounded in TIME by the pool statement_timeout lib/postgres.ts
 * already sets. The cap ended up in front of THAT -- throttling a single
 * cheap DB read on behalf of a vendor call it no longer gated.
 *
 * So: the archive leg takes every id, the remote leg keeps a budget, and
 * whatever neither leg reaches is REPORTED. These tests drive the real
 * splitter rather than re-deriving its arithmetic, and the source-shape
 * tests at the bottom check that each route actually wired it up -- a
 * correct planner nobody calls is the same silent miss as no planner.
 */

// ---------------------------------------------------------------------------
// The splitter, driven for real.
// ---------------------------------------------------------------------------

test("the archive leg gets EVERY distinct id, no matter how many", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `t${i}`);
  // Nothing archived: the worst case for the remote leg, and still the
  // archive must have been ASKED about all 500.
  const plan = planArtLookups(ids, () => false);
  assert.equal(plan.archiveIds.length, 500, "the cheap indexed read must not be capped");
  assert.deepEqual(plan.archiveIds, ids);
});

test("a fully archived page makes NO remote calls, at any size", () => {
  const ids = Array.from({ length: 1_000 }, (_, i) => `t${i}`);
  const plan = planArtLookups(ids, () => true);
  assert.equal(plan.remoteIds.length, 0, "the archive answered; nothing is owed to the vendor");
  assert.equal(plan.unresolvedIds.length, 0);
  assert.equal(plan.artIncomplete, false);
  // This is the case the old `.slice(0, 30)` broke hardest: 1,000 tokens the
  // archive fully holds, 970 of which rendered blank for no reason at all.
  assert.equal(plan.archiveIds.length, 1_000);
});

test("the budget bites only on what the archive could not answer", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
  // The archive holds the first 80. 20 gaps, well under the budget, so the
  // vendor leg is 20 -- NOT 30, and NOT the first 30 ids.
  const plan = planArtLookups(ids, (id) => Number(id.slice(1)) < 80, 30);
  assert.deepEqual(plan.remoteIds, ids.slice(80));
  assert.equal(plan.remoteIds.length, 20);
  assert.equal(plan.artIncomplete, false, "every gap fit inside the budget");
});

test("a page of 100 gaps is paced at the budget and SAYS what it dropped", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const plan = planArtLookups(ids, () => false, 30);
  assert.equal(plan.remoteIds.length, 30, "the vendor leg is still paced");
  assert.equal(plan.unresolvedIds.length, 70);
  assert.equal(plan.artIncomplete, true, "a partial answer must announce itself");
  // The two legs partition the page exactly -- no id is counted twice and
  // none silently disappears between them.
  const covered = [...plan.remoteIds, ...plan.unresolvedIds];
  assert.deepEqual(covered, plan.archiveIds);
});

test("the budget is spent on gaps, not on the first N ids of the page", () => {
  // THE ORIGINAL BUG, stated precisely. Archive holds everything EXCEPT the
  // last 5 tokens of a 40-token page. The old code sliced the page to 30 and
  // never looked at tokens 30-39, so those 5 real gaps were never fetched
  // while 30 already-answered tokens occupied the whole budget.
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const plan = planArtLookups(ids, (id) => Number(id.slice(1)) < 35, 30);
  assert.deepEqual(plan.remoteIds, ["t35", "t36", "t37", "t38", "t39"]);
  assert.equal(plan.artIncomplete, false);
});

test('token "0" is a real token, as a string AND as a number', () => {
  // The listings route already carries this scar: `!tokenId` is falsy for
  // the string "0" -- the first mint of most collections -- so a truthiness
  // filter dropped it. Same trap in the id normaliser, with a second edge a
  // string-only test cannot reach: the owned path enumerates token ids that
  // arrive as NUMBERS, and `!0` is true. Both forms must survive, and only
  // genuine absence (null/undefined/blank) may be filtered.
  const plan = planArtLookups([0, "0", "1", "0", "  ", null, undefined, " 2 ", 3], () => false);
  assert.deepEqual(plan.archiveIds, ["0", "1", "2", "3"], "0 survives in both forms; blanks and dupes do not");
  // Stated as its own assertion so a change to the surrounding list cannot
  // quietly stop exercising the zero case.
  assert.ok(distinctTokenIds([0]).includes("0"), "numeric token 0 must not be filtered as falsy");
  assert.deepEqual(distinctTokenIds([null, undefined, "", "   "]), [], "only real absence is filtered");
});

test("a budget of 0 means no remote leg exists, and everything unanswered is reported", () => {
  // The offers route passes 0 when there is no OpenSea key. That must read
  // as "nothing was asked", not as "everything was asked and came back
  // empty".
  const plan = planArtLookups(["a", "b"], () => false, 0);
  assert.equal(plan.remoteIds.length, 0);
  assert.deepEqual(plan.unresolvedIds, ["a", "b"]);
  assert.equal(plan.artIncomplete, true);
});

test("a nonsense budget degrades to 'fetched nothing, and said so'", () => {
  // Passing the budget straight to slice() is not safe: `slice(0, NaN)`
  // returns [] while `slice(NaN)` returns the WHOLE array, and
  // `slice(0, Infinity)` returns everything while `slice(Infinity)` returns
  // [] -- so a bad budget can produce either "fetched nothing but reported
  // it" (survivable) or "fetched nothing and reported nothing wrong" (the
  // exact silent shape this whole change exists to remove).
  //
  // Checking only that the two legs sum to the gap count does NOT catch
  // this: NaN happens to satisfy that sum. The real property is stronger --
  // a budget that is not a usable positive count must clamp to zero remote
  // work with EVERY gap reported.
  for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, 0.4]) {
    const plan = planArtLookups(["a", "b"], () => false, bad);
    assert.deepEqual(plan.remoteIds, [], `budget ${bad} must not be handed to the vendor leg`);
    assert.deepEqual(plan.unresolvedIds, ["a", "b"], `budget ${bad} must report every gap it skipped`);
    assert.equal(plan.artIncomplete, true, `budget ${bad} must not read as complete`);
  }
  // And a fractional budget above 1 floors rather than reaching slice() raw.
  const frac = planArtLookups(["a", "b", "c"], () => false, 2.9);
  assert.deepEqual(frac.remoteIds, ["a", "b"]);
  assert.deepEqual(frac.unresolvedIds, ["c"]);
});

test("distinctTokenIds preserves first-seen order", () => {
  // The remote budget takes a prefix, so ordering decides WHICH gaps get
  // fetched. It must be the page's own order (cheapest-ask first, in
  // listings), not insertion-independent hash order.
  assert.deepEqual(distinctTokenIds(["c", "a", "c", "b", "a"]), ["c", "a", "b"]);
});

// ---------------------------------------------------------------------------
// The concurrency primitive the owned route's deadline rides on.
// ---------------------------------------------------------------------------

test("mapWithConcurrency never exceeds its limit and keeps input order", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return n * 2;
  });
  assert.equal(peak, 5, "a single RPC node must not see an unbounded socket fan-out");
  assert.deepEqual(out, items.map((n) => n * 2), "results stay aligned with their inputs");
});

test("mapWithConcurrency on an empty list resolves rather than hanging", async () => {
  assert.deepEqual(await mapWithConcurrency([], 8, async () => 1), []);
});

test("a deadline stops STARTING work without dropping it silently", async () => {
  // This is the owned route's loop, reduced to the part worth proving: once
  // the deadline passes, remaining items are recorded as SKIPPED, not
  // returned as an art-less answer. A skipped token and a token with no art
  // must never look the same.
  const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const deadline = Date.now() + 25;
  const skipped: string[] = [];
  const entries = await mapWithConcurrency(ids, 2, async (id) => {
    if (Date.now() >= deadline) {
      skipped.push(id);
      return [id, null] as const;
    }
    await new Promise((r) => setTimeout(r, 10));
    return [id, { name: id, imageUrl: `https://x/${id}` }] as const;
  });
  assert.ok(skipped.length > 0, "a 25ms deadline over 20x10ms of work must actually bite");
  const answered = entries.filter(([, art]) => art !== null);
  assert.equal(answered.length + skipped.length, ids.length, "every token is either answered or counted");
  // The load-bearing property: nothing that was skipped got written into the
  // answer map as a real "no art" result.
  const artByToken = new Map<string, { name: string; imageUrl: string }>();
  for (const [id, art] of entries) if (art) artByToken.set(id, art);
  for (const id of skipped) assert.equal(artByToken.has(id), false, `${id} was never asked, so it has no answer`);
});

// ---------------------------------------------------------------------------
// Each route must actually be wired to the planner -- and must report.
// ---------------------------------------------------------------------------

function routeSrc(name: string): string {
  return readFileSync(path.join(process.cwd(), `app/api/market/multichain/${name}/route.ts`), "utf8");
}

/** Comments explain the fix; they must not be able to SATISFY the test. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("no route still slices its art id list to an arbitrary count", () => {
  for (const name of ["listings", "offers", "owned"]) {
    const src = code(routeSrc(name));
    assert.ok(
      !/slice\(\s*0\s*,\s*(30|MAX_ART_LOOKUPS)\s*\)/.test(src),
      `${name}/route.ts still caps its art list by count`,
    );
    assert.ok(!/\bMAX_ART_LOOKUPS\b/.test(src), `${name}/route.ts still names the old page-wide cap`);
  }
});

test("listings hands the archive every distinct id and budgets only the vendor", () => {
  const src = code(routeSrc("listings"));
  // The archive call takes the full list, and the list itself is built by
  // the shared normaliser rather than an ad-hoc truthiness filter.
  assert.ok(/const distinctTokenIds = distinctIds\(/.test(src), "the id list is built uncapped");
  assert.ok(
    /readProjectedTokensByIds\([\s\S]{0,120}distinctTokenIds\s*\)/.test(src),
    "the archive read must receive the whole distinct list",
  );
  assert.ok(/const missingFromArchive = artPlan\.remoteIds;/.test(src), "only the gaps go to OpenSea");
  assert.ok(/MAX_REMOTE_ART_LOOKUPS/.test(src), "the budget must name the leg it bounds");
});

test("offers reads the archive before it pays a vendor", () => {
  const src = code(routeSrc("offers"));
  assert.ok(
    /readProjectedTokensByIds\(chainSlug, collectionSlug, specificTokenIds\)/.test(src),
    "offers had NO archive leg at all; every token was a cold OpenSea call",
  );
  // From the CALL site, not the import line -- slicing from the first
  // occurrence reads the import statement and proves nothing.
  const at = src.indexOf("readProjectedTokensByIds(chainSlug");
  assert.ok(at > 0, "found the offers archive call");
  assert.ok(
    /\.catch\(/.test(src.slice(at, at + 300)),
    "a slow archive must degrade to the vendor, never 500 the Offers tab",
  );
  assert.ok(/missingFromArchive\.map\(async \(tokenId\)/.test(src), "the vendor fan-out is scoped to the gaps");
});

test("owned reads the archive and bounds its RPC leg by TIME", () => {
  const src = code(routeSrc("owned"));
  assert.ok(
    /readProjectedTokensByIds\(chainSlug, contractAddress, tokenIds\)/.test(src),
    "the wallet's whole holding goes to the archive, uncapped",
  );
  assert.ok(/ART_RPC_DEADLINE_MS/.test(src), "the remaining bound must be a deadline, not a count");
  assert.ok(/Date\.now\(\) >= rpcDeadline/.test(src), "the deadline must actually be consulted per item");
  assert.ok(/MAX_CONCURRENT_ART_RPC/.test(src), "one RPC node must not see an unbounded fan-out");
});

test("every route reports incomplete art instead of returning blank cards", () => {
  // The house rule: if a miss is indistinguishable from "nothing happened",
  // the test is wrong. `imageUrl: null` meant three different things and the
  // caller could tell them apart in none of them.
  for (const name of ["listings", "offers", "owned"]) {
    const src = code(routeSrc(name));
    assert.ok(/artCoverage:\s*\{/.test(src), `${name}/route.ts returns no art-coverage object`);
    assert.ok(/unresolvedTokens:/.test(src), `${name}/route.ts does not count what it could not resolve`);
    assert.ok(/complete:/.test(src), `${name}/route.ts does not say whether the art is complete`);
  }
  assert.ok(/artIncomplete:/.test(code(routeSrc("owned"))), "owned must carry the explicit flag");
});

test("the exported budgets are real numbers, not accidental zeroes", () => {
  assert.ok(MAX_REMOTE_ART_LOOKUPS > 0 && Number.isInteger(MAX_REMOTE_ART_LOOKUPS));
  assert.ok(ART_RPC_DEADLINE_MS > 0);
  assert.ok(MAX_CONCURRENT_ART_RPC > 0);
  // The deadline must leave room under the per-metadata-fetch
  // AbortSignal.timeout(8000) the owned route already uses, or an item
  // started just under the line doubles the request budget.
  assert.ok(ART_RPC_DEADLINE_MS < 8_000, "the deadline must sit inside the per-item fetch timeout");
});
