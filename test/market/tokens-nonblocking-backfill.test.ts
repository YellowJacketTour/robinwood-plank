import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * /api/market/multichain/tokens ran TWO vendor passes inside the visitor's
 * request before writing the response:
 *
 *   1. a catalog fetch -- up to 200 rows from OpenSea, or 80 from UniSat /
 *      Helius for Bitcoin and Solana
 *   2. up to 16 per-token image lookups (resolveTokenImagesForPage)
 *
 * Both were awaited, and the route answers `Cache-Control: no-store`, so every
 * visitor paid both again and the page could not paint until rate-limited
 * vendors had answered.
 *
 * The work is worth doing -- updateForeignRarityImages writes resolved URLs
 * into plank_foreign_rarity DURABLY, so whatever it resolves is free for every
 * later visitor. That is precisely why it does not need to block THIS one.
 *
 * Templating is a different case and must stay inline: it is a pure string
 * build with no I/O (token-art-templates.ts), it fills the whole page for any
 * collection that has a template, and it costs nothing. Detaching it would
 * make pages render imageless for no gain.
 *
 * WHAT IS ASSERTED HERE
 * ---------------------
 * Source-level structure. Driving the route would need a live OpenSea key, a
 * seeded rarity store and a DOM; the properties that actually matter are
 * structural and a regression is invisible without them:
 *
 *   - the vendor passes are detached (not awaited before the response)
 *   - templating is NOT detached
 *   - the detached work still persists what it resolves
 *   - the detached pass does not mutate the already-serialised page array
 */

const SRC = readFileSync(
  new URL("../../app/api/market/multichain/tokens/route.ts", import.meta.url),
  "utf8"
);

/** The detached backfill body, isolated so assertions cannot match elsewhere. */
const BACKFILL =
  /const runVendorBackfill = async \(\) => \{[\s\S]*?\n          \};/.exec(SRC)?.[0] ?? "";

test("the vendor backfill exists as a detached unit", () => {
  assert.ok(BACKFILL.length > 0, "runVendorBackfill must exist for the rest of this file to mean anything");
  assert.match(
    SRC,
    /void runVendorBackfill\(\)\.catch\(\(\) => \{\}\)/,
    "it must be fired without await -- an awaited 'detached' pass is the bug this fixes"
  );
});

test("no vendor catalog fetch is awaited on the response path", () => {
  // Strip the detached body, then assert the remaining route never awaits a
  // catalog call. This is the regression that matters: someone re-inlining
  // `await openSeaTokens(...)` above the response restores the old latency
  // while every other test still passes.
  const withoutBackfill = SRC.replace(BACKFILL, "");
  const projectionBlock =
    /if \(hasForeignRarityStore\(\)\) \{[\s\S]*?return NextResponse\.json\(\s*\{ tokens: indexed/.exec(
      withoutBackfill
    )?.[0] ?? "";
  assert.ok(projectionBlock.length > 0, "the projection-hit block must be locatable");
  for (const call of ["openSeaTokens", "bitcoinTokens", "solanaTokens", "resolveTokenImagesForPage"]) {
    assert.doesNotMatch(
      projectionBlock,
      new RegExp(`await ${call}\\(`),
      `${call} is awaited before the response on the projection-hit path -- that is the ` +
        `blocking vendor call this change removed`
    );
  }
});

test("templating stays inline, because it is free and fills the page", () => {
  assert.doesNotMatch(
    BACKFILL,
    /templatedErc721Image/,
    "templating is a pure string build with no I/O; detaching it would render pages " +
      "imageless for no latency gain"
  );
  assert.match(SRC, /templatedErc721Image/, "templating must still run inline");
});

test("the detached pass still persists what it resolves", () => {
  // If it resolved images and dropped them, the route would re-pay the same
  // vendor calls on every single load forever -- strictly worse than blocking.
  const writes = [...BACKFILL.matchAll(/updateForeignRarityImages\(/g)];
  assert.ok(
    writes.length >= 2,
    `the detached pass must persist BOTH the catalog fill and the per-token lookups; ` +
      `found ${writes.length} write(s)`
  );
});

test("the detached pass does not mutate the array already sent to the client", () => {
  // `indexed` is serialised into the response before this runs. Mutating it
  // afterwards writes to state nobody reads -- harmless today, and exactly the
  // kind of thing that becomes a real bug if the response is later built
  // lazily.
  assert.match(
    BACKFILL,
    /const pending = indexed\s*\n?\s*\.filter\(\(t\) => !t\.imageUrl\)\s*\n?\s*\.map\(/,
    "the detached pass must work on a copy, not on the response array"
  );
  assert.doesNotMatch(
    BACKFILL,
    /for \(const t of indexed\)/,
    "iterating `indexed` directly in the detached pass would mutate the sent response"
  );
});

test("the response is still built from the indexed rows, so templated images ship", () => {
  assert.match(
    SRC,
    /\{ tokens: indexed\.map\(\(t\) => \(\{ tokenId: t\.tokenId, name: t\.name, imageUrl: t\.imageUrl \}\)\) \}/,
    "the response must carry imageUrl from the indexed rows -- templating mutates them in place"
  );
});
