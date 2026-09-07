import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import {
  METADATA_ATTEMPT_CAP,
  PROJECTION_WRITE_CHUNK,
  readMetadataCoverageCounters,
  readTokenMetadataWork,
  upsertCollectionTokenProjection,
  writeTokenMetadataResult,
} from "../../lib/market/multichain/collection-token-store";

/**
 * AUDIT Batch F10 / F3b / F5 -- runs against the real local Postgres (the
 * store is a thin SQL wrapper; there is nothing to mock). Rows are cleaned
 * up in `finally`.
 */
const chainSlug = "test-chain";
const collectionSlug = `zztest-bulk-${Date.now().toString(36)}`;

async function cleanup() {
  await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
  await postgresQuery(`DELETE FROM plank_collection_token_projections WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
  await postgresQuery(`DELETE FROM plank_collection_membership_cursors WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
}

test("bulk unnest write: 1,203 rows land in one call, chunked, with merge semantics and duplicate ids collapsed", { skip: !hasPostgresConfig() }, async () => {
  try {
    const n = PROJECTION_WRITE_CHUNK * 2 + 203;
    const tokens = Array.from({ length: n }, (_, i) => ({
      tokenId: String(i),
      name: i % 2 === 0 ? `Token ${i}` : null,
      imageUrl: i % 3 === 0 ? `ipfs://img/${i}` : null,
      traits: i % 5 === 0 ? [{ traitType: "Hat", value: "Cap" }] : [],
      rarityScore: i % 7 === 0 ? i / 7 : null,
      rarityRank: i % 7 === 0 ? i : null,
    }));
    // A duplicate id inside one page must not blow up ON CONFLICT; the last wins.
    tokens.push({ tokenId: "0", name: "Token 0 (dup, last wins)", imageUrl: null, traits: [], rarityScore: null, rarityRank: null });
    await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
      tokens, expectedCount: n, partial: true, provenance: ["test-bulk"], sourceObservedAt: new Date(),
    });
    const count = await postgresQuery<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
    assert.equal(Number(count.rows[0].c), n);
    const proj = await postgresQuery<{ projected_count: number; expected_count: number }>(
      `SELECT projected_count, expected_count FROM plank_collection_token_projections WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
    assert.equal(Number(proj.rows[0].projected_count), n);
    assert.equal(Number(proj.rows[0].expected_count), n);
    const row0 = await postgresQuery<{ name: string; traits: unknown; rarity_rank: number | null }>(
      `SELECT name, traits, rarity_rank FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2 AND token_id = '0'`, [chainSlug, collectionSlug]);
    assert.equal(row0.rows[0].name, "Token 0 (dup, last wins)");
    assert.deepEqual(row0.rows[0].traits, [{ traitType: "Hat", value: "Cap" }], "empty traits in the dup must not erase the first write's traits");
    assert.equal(row0.rows[0].rarity_rank, 0);

    // Second page: null fields never erase, non-empty traits replace.
    await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
      tokens: [{ tokenId: "10", name: null, traits: [{ traitType: "Hat", value: "Crown" }] }],
      partial: true, preservePartial: true, provenance: ["test-bulk-2"], sourceObservedAt: new Date(),
    });
    const row10 = await postgresQuery<{ name: string; traits: unknown; provenance: string[] }>(
      `SELECT name, traits, provenance FROM plank_collection_tokens WHERE chain_slug = $1 AND collection_slug = $2 AND token_id = '10'`, [chainSlug, collectionSlug]);
    assert.equal(row10.rows[0].name, "Token 10");
    assert.deepEqual(row10.rows[0].traits, [{ traitType: "Hat", value: "Crown" }]);
    assert.deepEqual([...row10.rows[0].provenance].sort(), ["test-bulk", "test-bulk-2"]);
  } finally {
    await cleanup();
  }
});

test("readTokenMetadataWork skips retry rows at the attempt cap; coverage counters are honest", { skip: !hasPostgresConfig() }, async () => {
  try {
    await upsertCollectionTokenProjection(chainSlug, collectionSlug, {
      tokens: [
        { tokenId: "1", name: "one", imageUrl: "ipfs://1", traits: [{ traitType: "Hat", value: "Cap" }] },
        { tokenId: "2", name: null, traits: [] },
        { tokenId: "3", name: null, traits: [] },
        { tokenId: "4", name: null, traits: [] },
      ],
      expectedCount: 10, partial: true, provenance: ["test-bulk"], sourceObservedAt: new Date(),
    });
    await writeTokenMetadataResult({ chainSlug, collectionSlug, tokenId: "1", state: "complete" });
    await writeTokenMetadataResult({ chainSlug, collectionSlug, tokenId: "2", state: "empty" });
    // Token 3: an old retry row already at the cap (pre-migration shape), token 4: one retry, eligible again after 30 min.
    await postgresQuery(
      `UPDATE plank_collection_tokens SET metadata_state = 'retry', metadata_attempts = $3, metadata_attempted_at = NOW() - INTERVAL '2 hours'
       WHERE chain_slug = $1 AND collection_slug = $2 AND token_id = '3'`, [chainSlug, collectionSlug, METADATA_ATTEMPT_CAP]);
    await postgresQuery(
      `UPDATE plank_collection_tokens SET metadata_state = 'retry', metadata_attempts = 1, metadata_attempted_at = NOW() - INTERVAL '2 hours'
       WHERE chain_slug = $1 AND collection_slug = $2 AND token_id = '4'`, [chainSlug, collectionSlug]);
    const work = await readTokenMetadataWork(chainSlug, 100, collectionSlug);
    assert.deepEqual(work.map((w) => w.tokenId), ["4"], "only the under-cap retry is handed out");

    const counters = await readMetadataCoverageCounters(chainSlug, collectionSlug);
    assert.deepEqual(counters, { expected: 10, rows: 4, terminal: 2, withTraits: 1, withImage: 1 });

    // Expected can never be smaller than the rows we hold.
    await postgresQuery(`UPDATE plank_collection_token_projections SET expected_count = 2 WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, collectionSlug]);
    assert.equal((await readMetadataCoverageCounters(chainSlug, collectionSlug)).expected, 4);
  } finally {
    await cleanup();
  }
});
