/**
 * Storage layer for deploy/inmotion/postgres/migrations/014_foreign_rarity.sql.
 * See that migration for why this is a background-indexed table rather
 * than a live per-request computation.
 */
import { hasPostgresConfig, postgresQuery, postgresPool } from "@/lib/postgres";
import type { GenericRaritySnapshot } from "@/lib/rarity-generic";

export function hasForeignRarityStore(): boolean {
  return hasPostgresConfig();
}

type RarityRow = {
  token_id: string;
  name: string;
  score: number;
  rank: number;
  percentile: number;
  tier: string;
};

export async function getForeignRarity(
  chainSlug: string,
  collectionSlug: string
): Promise<Map<string, { name: string; tier: string; rank: number; percentile: number }>> {
  const result = await postgresQuery<RarityRow>(
    `SELECT token_id, name, score, rank, percentile, tier
     FROM plank_foreign_rarity
     WHERE chain_slug = $1 AND collection_slug = $2`,
    [chainSlug, collectionSlug]
  );
  const map = new Map<string, { name: string; tier: string; rank: number; percentile: number }>();
  for (const row of result.rows) {
    map.set(row.token_id, { name: row.name, tier: row.tier, rank: row.rank, percentile: row.percentile });
  }
  return map;
}

/** traitType -> value -> [tokenId], same shape as native's TraitIndexResponse.traits (lib/market/traits.ts) -- powers ForeignOfferForm's criteria-bid builder via the SAME pure resolveCriteriaTokenIds (trait-criteria.ts) native uses. */
export type ForeignTraitIndex = Record<string, Record<string, string[]>>;

export async function getForeignTraitIndex(
  chainSlug: string,
  collectionSlug: string
): Promise<{ traitIndex: ForeignTraitIndex | null; sampleSize: number; indexedAt: string | null }> {
  const result = await postgresQuery<{ trait_index: ForeignTraitIndex | null; sample_size: number; indexed_at: string }>(
    `SELECT trait_index, sample_size, indexed_at FROM plank_foreign_rarity_collections WHERE chain_slug = $1 AND collection_slug = $2`,
    [chainSlug, collectionSlug]
  );
  const row = result.rows[0];
  if (!row) return { traitIndex: null, sampleSize: 0, indexedAt: null };
  return { traitIndex: row.trait_index, sampleSize: row.sample_size, indexedAt: row.indexed_at };
}

/** Full replace for one collection -- rarity is a snapshot ("current best estimate from the last full index"), not an append-only history, so a re-index supersedes the prior run entirely rather than merging with it. */
export async function replaceForeignRarity(
  chainSlug: string,
  collectionSlug: string,
  snapshot: GenericRaritySnapshot,
  traitIndex: ForeignTraitIndex
): Promise<void> {
  const pool = postgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM plank_foreign_rarity WHERE chain_slug = $1 AND collection_slug = $2`, [
      chainSlug,
      collectionSlug,
    ]);
    for (const r of snapshot.byTokenId.values()) {
      await client.query(
        `INSERT INTO plank_foreign_rarity (chain_slug, collection_slug, token_id, name, score, rank, percentile, tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [chainSlug, collectionSlug, r.tokenId, r.name, r.score, r.rank, r.percentile, r.tier]
      );
    }
    await client.query(
      `INSERT INTO plank_foreign_rarity_collections (chain_slug, collection_slug, sample_size, trait_index, indexed_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (chain_slug, collection_slug) DO UPDATE SET sample_size = EXCLUDED.sample_size, trait_index = EXCLUDED.trait_index, indexed_at = NOW()`,
      [chainSlug, collectionSlug, snapshot.sampleSize, JSON.stringify(traitIndex)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
