import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * Real gap found live 2026-08-27 (external research: "the melt bar lies
 * if L1 and L4 get blended into one number"). Proven live on a real
 * collection: CloneX's own archivalScore/tokensEverHydrated already read
 * 19,764/19,764 (100%, genuinely correct real membership, thanks to
 * tonight's earlier fixes), while real trait/metadata coverage
 * (name/image actually present) was only 6,965/19,764 -- 35.2%. The
 * existing "Archive depth" bar had no way to show this real gap; it read
 * as fully done while 65% of tokens still had no real trait data.
 * metadataTokens/metadataCoverage expose this as a real, separate,
 * honestly-labeled signal.
 */
test(
  "getArchivalStatsForCollection reports metadata coverage separately from membership",
  { skip: !hasPostgresConfig() },
  async () => {
    const { getArchivalStatsForCollection } = await import("../../lib/market/multichain/archival-ledger");
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chainSlug = "eth-mainnet";
    const address = `0x${suffix.replace(/[^0-9a-z]/g, "").padEnd(40, "0").slice(0, 40)}`;
    const collectionId = (
      await postgresQuery<{ id: number }>(
        `INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter) VALUES ($1, $2, 'test') RETURNING id`,
        [chainSlug, address]
      )
    ).rows[0].id;
    try {
      await postgresQuery(`INSERT INTO plank_multichain_snapshots (collection_id, total_supply) VALUES ($1, 4)`, [collectionId]);
      // 4 real membership rows, only 1 with real metadata -- mirrors the
      // real CloneX gap (full membership, partial metadata) at small scale.
      for (let i = 0; i < 4; i++) {
        await postgresQuery(
          `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, name, source_observed_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [chainSlug, address, String(i), i === 0 ? "Real Token #0" : null]
        );
      }
      await postgresQuery(
        `INSERT INTO plank_collection_token_projections (chain_slug, collection_slug, projected_count, partial, provenance, source_observed_at)
         VALUES ($1, $2, 4, false, ARRAY['test'], NOW())`,
        [chainSlug, address]
      );
      const now = new Date();
      await postgresQuery(
        `INSERT INTO collection_archival_stats (chain_slug, collection_key, known_supply, tokens_ever_hydrated, archival_score, score_method, fills_ever_stored, first_archived_at, last_archived_at, organic_hits)
         VALUES ($1, $2, 4, 4, 1, 'supply_ratio', 0, $3, $3, 0)`,
        [chainSlug, address, now]
      );

      const stats = await getArchivalStatsForCollection(chainSlug, address);
      assert.ok(stats, "must return a real shape for a collection with real rows");
      assert.equal(stats!.metadataTokens, 1, "exactly 1 of 4 rows has real name/image");
      assert.ok(
        stats!.metadataCoverage != null && Math.abs(stats!.metadataCoverage - 0.25) < 0.01,
        `expected ~0.25 metadata coverage, got ${stats!.metadataCoverage}`
      );
    } finally {
      await postgresQuery(`DELETE FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM plank_collection_token_projections WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, address]);
      await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]);
      await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
    }
  }
);
