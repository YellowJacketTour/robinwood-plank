import assert from "node:assert/strict";
import test from "node:test";
import { decodeTokenCursor, encodeTokenCursor, searchProjectedTokens } from "../../lib/market/multichain/collection-token-store";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

test("collection token cursors round-trip opaque token identifiers", () => {
  for (const id of ["42", "0xabc/def+ghi", "inscription:i0", "mint-unicode-ü"]) {
    const cursor = encodeTokenCursor(id);
    assert.deepEqual(decodeTokenCursor(cursor), { tokenId: id, rarityRank: null });
    assert.equal(cursor.includes(id), false);
  }
});

test("collection token cursor rejects malformed and non-canonical values", () => {
  assert.equal(decodeTokenCursor(null), null);
  assert.equal(decodeTokenCursor(""), null);
  assert.equal(decodeTokenCursor("%%%not-base64%%%"), null);
  assert.equal(decodeTokenCursor("YQ=="), null);
});

test("token cursor preserves a composite rarity key", () => {
  assert.deepEqual(decodeTokenCursor(encodeTokenCursor("8421", 3115)), {
    tokenId: "8421", rarityRank: 3115,
  });
});

/**
 * Global search ranked equally-relevant results only by recency
 * (projected_at DESC), so a not-yet-enriched token (image_url null --
 * "ART PENDING") could rank above an already-enriched real match with the
 * same relevance. Fixed by adding `(image_url IS NULL)` as a tertiary ORDER
 * BY key, ahead of recency, in searchProjectedTokens. This runs against the
 * real local Postgres store (same one the app uses) with two synthetic rows
 * inserted and cleaned up, rather than a mock -- the store is a thin SQL
 * wrapper with no logic to fake around.
 */
test("search ranks an enriched match ahead of an unenriched match of equal relevance", { skip: !hasPostgresConfig() }, async () => {
  const chainSlug = "test-chain";
  const collectionSlug = "zztest-collection-ranking";
  const unenrichedTokenId = "zztest-unenriched-1";
  const enrichedTokenId = "zztest-enriched-2";
  await postgresQuery(
    `INSERT INTO plank_collection_tokens
       (chain_slug, collection_slug, token_id, name, image_url, source_observed_at, projected_at)
     VALUES
       ($1, $2, $3, 'ZZTest Unenriched', NULL, NOW(), NOW()),
       ($1, $2, $4, 'ZZTest Enriched', 'https://example.invalid/art.png', NOW(), NOW() - INTERVAL '1 hour')`,
    [chainSlug, collectionSlug, unenrichedTokenId, enrichedTokenId]
  );
  try {
    const hits = await searchProjectedTokens({ query: "zztest-", chainSlugs: [chainSlug], limit: 10 });
    const ids = hits.map((h) => h.tokenId);
    assert.ok(ids.includes(unenrichedTokenId) && ids.includes(enrichedTokenId), "both synthetic rows should match");
    assert.ok(
      ids.indexOf(enrichedTokenId) < ids.indexOf(unenrichedTokenId),
      `enriched row (image_url set) should rank first despite being older; got order ${JSON.stringify(ids)}`
    );
  } finally {
    await postgresQuery(
      `DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`,
      [chainSlug, collectionSlug]
    );
  }
});
