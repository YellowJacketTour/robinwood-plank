import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The listings route must read the archive before it asks a vendor.
 *
 * MEASURED 2026-09-08. The route resolved per-token art with up to
 * MAX_ART_LOOKUPS live OpenSea calls, every one awaited before any bytes
 * reached the visitor: 9s typical on Milady Maker, samples past 120s. At the
 * same moment that collection reported archivalScore 1, metadataCoverage 1
 * and traitsCoverage 1 -- the archive already held every one of those tokens'
 * name, image and traits, and production's own /tokens route returns them
 * (verified live: "Milady 0" with a real seadn.io image URL).
 *
 * So the page was paying a vendor, per token, per render, for data it had
 * already stored. `plank_collection_tokens` is keyed
 * (chain_slug, collection_slug, token_id) with a browse index, so the whole
 * page is ONE indexed query.
 *
 * WHY NOT JUST CACHE THE VENDOR CALL. There was already a 5-minute
 * singleflight cache on it. A cache in front of a puller freezes whatever the
 * puller last said; it does not make the page independent of the puller. The
 * archive is the thing that survives a vendor going dark, which is the entire
 * reason for keeping one.
 */

const SRC = readFileSync(
  path.join(process.cwd(), "app/api/market/multichain/listings/route.ts"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the route reads the token archive", () => {
  assert.ok(
    /readProjectedTokensByIds\(/.test(SRC),
    "art must come from plank_collection_tokens, not from a vendor round trip per token",
  );
});

test("the live vendor fetch runs ONLY for tokens the archive lacks", () => {
  // The bug shape: mapping the vendor fetch over every distinct token.
  assert.ok(
    !/distinctTokenIds\.map\(async \(tokenId\)/.test(SRC),
    "fanning out over every token re-pays for data already stored",
  );
  assert.ok(
    /missingFromArchive\.map\(async \(tokenId\)/.test(SRC),
    "the vendor path must be scoped to the genuine gaps",
  );
  // The gap set must be derived from what the archive actually returned.
  // (It is now produced by planArtLookups, which takes the archive's own
  // answer as its predicate -- see lib/market/multichain/art-lookup-plan.ts
  // and test/market/art-lookup-budget.test.ts, which drive that split for
  // real instead of reading it out of this file.)
  assert.ok(
    /const missingFromArchive = artPlan\.remoteIds;/.test(SRC),
    "the vendor set must be the planner's remote leg, not the whole page",
  );
  assert.ok(
    /planArtLookups\(\s*distinctTokenIds,/.test(SRC),
    "the planner must be handed every distinct token, not a truncated prefix",
  );
});

test("an archived row with no art is treated as a gap, not as an answer", () => {
  // An empty row must not silently render a blank card: that would be the
  // archive certifying "nothing" the same way a 404 page once certified an
  // empty book.
  // Written as the POSITIVE predicate planArtLookups asks for ("does the
  // archive hold a usable row"), which is the De Morgan twin of the
  // original `!row || (!row.imageUrl && !row.name)`.
  assert.ok(
    /!!row && \(!!row\.imageUrl \|\| !!row\.name\)/.test(SRC),
    "a row with neither name nor image is not a usable answer",
  );
});

test("the archive read cannot take the page down", () => {
  // Postgres being slow or down must degrade to the vendor path, never to a
  // 500 -- the archive is an optimisation over a working path, not a new
  // hard dependency for rendering a book.
  const at = SRC.indexOf("readProjectedTokensByIds(");
  const call = SRC.slice(at, at + 400);
  assert.ok(
    /\.catch\(/.test(call),
    "a failed archive read must fall through to the vendor, not throw",
  );
});

test("the archive wins over the vendor when both have a token", () => {
  // Ordering matters: the merge must not let a stale vendor row overwrite a
  // fresher archived one, and must not double-fetch what it already merged.
  assert.ok(
    /if \(artByToken\.has\(tokenId\)\) continue;/.test(SRC),
    "already-resolved tokens are not overwritten during the merge",
  );
});
