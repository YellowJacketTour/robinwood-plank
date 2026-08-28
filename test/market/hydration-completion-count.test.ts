import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { isMembershipCountComplete } from "../../lib/market/multichain/discovery/hydration-completion";

/**
 * Real gap found live 2026-08-27 ("does it know it's reached 100% on
 * CloneX?"): no. Its real row count in plank_collection_tokens had already
 * reached its real, known total_supply (19,764 of 19,764), but every
 * per-source completion flag (opensea-membership's own cursor,
 * anchored-membership's own status) still said incomplete, because each
 * source only ever marks itself complete when ITS OWN pagination/scan
 * personally reaches its own end -- HyperSync had already fully populated
 * the collection through a different path, and OpenSea's own walk had no
 * way to know that. isMembershipCountComplete is the source-agnostic fix:
 * compare the real aggregate row count against the real, independently-
 * reported total_supply, regardless of which source(s) contributed rows.
 */
test(
  "isMembershipCountComplete recognizes completion once real rows reach the real total_supply, independent of any one source",
  { skip: !hasPostgresConfig() },
  async () => {
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chainSlug = "eth-mainnet";
    const address = `0x${suffix.replace(/[^0-9a-z]/g, "").padEnd(40, "0").slice(0, 40)}`;
    let collectionId: number | null = null;
    try {
      const inserted = await postgresQuery<{ id: number }>(
        `INSERT INTO plank_multichain_collections (chain_slug, contract_address, adapter)
         VALUES ($1, $2, 'test') RETURNING id`,
        [chainSlug, address]
      );
      collectionId = inserted.rows[0].id;

      // No total_supply known yet -- must never claim completeness from an
      // absent ceiling.
      assert.equal(await isMembershipCountComplete(chainSlug, address), false, "no known total_supply must never read as complete");

      await postgresQuery(
        `INSERT INTO plank_multichain_snapshots (collection_id, total_supply) VALUES ($1, 3)`,
        [collectionId]
      );
      assert.equal(await isMembershipCountComplete(chainSlug, address), false, "0 of 3 real rows must not be complete");

      for (const tokenId of ["1", "2"]) {
        await postgresQuery(
          `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at)
           VALUES ($1, $2, $3, NOW())`,
          [chainSlug, address, tokenId]
        );
      }
      assert.equal(await isMembershipCountComplete(chainSlug, address), false, "2 of 3 real rows must not yet be complete");

      await postgresQuery(
        `INSERT INTO plank_collection_tokens (chain_slug, collection_slug, token_id, source_observed_at)
         VALUES ($1, $2, $3, NOW())`,
        [chainSlug, address, "3"]
      );
      assert.equal(await isMembershipCountComplete(chainSlug, address), true, "3 of 3 real rows must read as complete, regardless of which source wrote them");
    } finally {
      await postgresQuery(`DELETE FROM plank_collection_tokens WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, address]);
      if (collectionId != null) {
        await postgresQuery(`DELETE FROM plank_multichain_snapshots WHERE collection_id = $1`, [collectionId]);
        await postgresQuery(`DELETE FROM plank_multichain_collections WHERE id = $1`, [collectionId]);
      }
    }
  }
);
