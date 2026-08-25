/**
 * Storage layer for deploy/inmotion/postgres/migrations/014_foreign_rarity.sql.
 * See that migration for why this is a background-indexed table rather
 * than a live per-request computation.
 */
import { hasPostgresConfig, postgresQuery, postgresPool } from "@/lib/postgres";
import type { GenericRaritySnapshot } from "@/lib/rarity-generic";
import { resolveCriteriaTokenIds, type CriteriaClause } from "@/lib/market/trait-criteria";

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
): Promise<Map<string, { name: string; tier: string; rank: number; percentile: number; score: number }>> {
  const result = await postgresQuery<RarityRow>(
    `SELECT token_id, name, score, rank, percentile, tier
     FROM plank_foreign_rarity
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [chainSlug, collectionSlug]
  );
  const map = new Map<string, { name: string; tier: string; rank: number; percentile: number; score: number }>();
  for (const row of result.rows) {
    map.set(row.token_id, { name: row.name, tier: row.tier, rank: row.rank, percentile: row.percentile, score: row.score });
  }
  return map;
}

/** Token catalog from the rarity index (JIT browse of every scored piece). */
export async function listForeignRarityTokens(
  chainSlug: string,
  collectionSlug: string,
  limit: number,
  opts?: { sort?: "id" | "rank" | "rank-desc"; tier?: string | null }
): Promise<Array<{ tokenId: string; name: string | null; imageUrl: string | null }>> {
  // Keep this fallback symmetric with the canonical token projection and
  // collection surface. The old 2,000 ceiling made a fully indexed 5,876
  // piece collection appear truncated whenever its projection row was
  // temporarily unavailable, even though every rarity row already existed.
  const cap = Math.min(Math.max(limit, 1), 800);
  const sort = opts?.sort ?? "id";
  const tier = opts?.tier?.trim() || null;
  const orderSql =
    sort === "rank"
      ? "rank ASC, token_id"
      : sort === "rank-desc"
        ? "rank DESC, token_id"
        : "CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END ASC NULLS LAST, token_id";
  const params: unknown[] = [chainSlug, collectionSlug];
  let where = `chain_slug = $1 AND lower(collection_slug) = lower($2)`;
  if (tier) {
    params.push(tier);
    where += ` AND lower(tier) = lower($${params.length})`;
  }
  params.push(cap);
  const limitPh = `$${params.length}`;
  try {
    const result = await postgresQuery<{ token_id: string; name: string; image_url: string | null }>(
      `SELECT token_id, name, image_url FROM plank_foreign_rarity
       WHERE ${where}
       ORDER BY ${orderSql}
       LIMIT ${limitPh}`,
      params
    );
    return result.rows.map((r) => ({ tokenId: r.token_id, name: r.name || null, imageUrl: r.image_url || null }));
  } catch {
    const result = await postgresQuery<{ token_id: string; name: string }>(
      `SELECT token_id, name FROM plank_foreign_rarity
       WHERE ${where}
       ORDER BY ${orderSql}
       LIMIT ${limitPh}`,
      params
    );
    return result.rows.map((r) => ({ tokenId: r.token_id, name: r.name || null, imageUrl: null }));
  }
}

/** Update ranks/tiers without DELETE (keeps image_url). */
export async function applyForeignRaritySnapshot(
  chainSlug: string,
  collectionSlug: string,
  snapshot: GenericRaritySnapshot
): Promise<void> {
  for (const r of snapshot.byTokenId.values()) {
    await postgresQuery(
      `UPDATE plank_foreign_rarity
       SET name = COALESCE(NULLIF($4, ''), name), score = $5, rank = $6, percentile = $7, tier = $8
       WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND token_id = $3`,
      [chainSlug, collectionSlug, r.tokenId, r.name, r.score, r.rank, r.percentile, r.tier]
    );
  }
}

export async function updateForeignRarityImages(
  chainSlug: string,
  collectionSlug: string,
  images: Array<{ tokenId: string; imageUrl: string }>
): Promise<number> {
  let n = 0;
  for (const row of images) {
    if (!row.imageUrl) continue;
    const r = await postgresQuery(
      `UPDATE plank_foreign_rarity SET image_url = $4
       WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND token_id = $3
         AND (image_url IS NULL OR image_url = '')`,
      [chainSlug, collectionSlug, row.tokenId, row.imageUrl]
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Rebuild −log2 snapshot from stored trait_index (no vendor calls). */
export function itemsFromTraitIndex(
  traitIndex: ForeignTraitIndex
): Array<{ tokenId: string; name: string | null; traits: Array<{ traitType: string; value: string }> }> {
  const byId = new Map<string, { tokenId: string; name: string | null; traits: Array<{ traitType: string; value: string }> }>();
  for (const [traitType, values] of Object.entries(traitIndex)) {
    for (const [value, ids] of Object.entries(values)) {
      for (const tokenId of ids) {
        let row = byId.get(tokenId);
        if (!row) {
          row = { tokenId, name: null, traits: [] };
          byId.set(tokenId, row);
        }
        row.traits.push({ traitType, value });
      }
    }
  }
  return [...byId.values()];
}

/** traitType -> value -> [tokenId], same shape as native's TraitIndexResponse.traits (lib/market/traits.ts) -- powers ForeignOfferForm's criteria-bid builder via the SAME pure resolveCriteriaTokenIds (trait-criteria.ts) native uses. */
export type ForeignTraitIndex = Record<string, Record<string, string[]>>;

export async function getForeignTraitIndex(
  chainSlug: string,
  collectionSlug: string
): Promise<{ traitIndex: ForeignTraitIndex | null; sampleSize: number; indexedAt: string | null; partial: boolean }> {
  const result = await postgresQuery<{ trait_index: ForeignTraitIndex | null; sample_size: number; indexed_at: string; partial: boolean }>(
    `SELECT trait_index, sample_size, indexed_at, partial FROM plank_foreign_rarity_collections WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [chainSlug, collectionSlug]
  );
  const row = result.rows[0];
  if (!row) return { traitIndex: null, sampleSize: 0, indexedAt: null, partial: true };
  return { traitIndex: row.trait_index, sampleSize: row.sample_size, indexedAt: row.indexed_at, partial: row.partial };
}

/**
 * Server-side, fail-closed re-derivation of a criteria clause's real
 * token-id set for a FOREIGN collection -- the foreign-chain counterpart
 * to lib/market/trait-index.ts's getVerifiedCriteriaTokenIds, which reads
 * Robinhood Chain's own trait index only. Used by
 * app/api/market/multichain/native-orders/route.ts to independently
 * re-verify a client-submitted criteria offer's token-id set from the
 * SAME real, background-indexed trait data ForeignOfferForm's picker UI
 * is built from -- never trusts client-supplied token ids directly, same
 * discipline as every other order-validation path in this app. Returns
 * null (fail closed) when the index isn't built/complete yet or the
 * clauses resolve to zero matching tokens -- a criteria offer against an
 * unindexed or non-matching collection is rejected, never silently
 * accepted with a fabricated set.
 */
export async function getVerifiedForeignCriteriaTokenIds(
  chainSlug: string,
  collectionSlug: string,
  clauses: readonly CriteriaClause[]
): Promise<{ tokenIds: string[] } | null> {
  if (clauses.length === 0) return null;
  const [{ traitIndex }, rarityMap] = await Promise.all([
    getForeignTraitIndex(chainSlug, collectionSlug),
    getForeignRarity(chainSlug, collectionSlug),
  ]);
  if (!traitIndex) return null;
  let rankings: Record<string, number> | null = null;
  if (clauses.some((c) => c.kind === "rank")) {
    rankings = {};
    for (const [tokenId, r] of rarityMap) rankings[tokenId] = r.rank;
  }
  const tokenIds = resolveCriteriaTokenIds(traitIndex, clauses, rankings);
  return tokenIds.length > 0 ? { tokenIds } : null;
}

/** Full replace for one collection -- rarity is a snapshot ("current best estimate from the last full index"), not an append-only history, so a re-index supersedes the prior run entirely rather than merging with it. */
export async function replaceForeignRarity(
  chainSlug: string,
  collectionSlug: string,
  snapshot: GenericRaritySnapshot,
  traitIndex: ForeignTraitIndex,
  aliases: string[] = [],
  images?: Map<string, string | null>
): Promise<void> {
  const keys = [...new Set([collectionSlug, ...aliases].filter(Boolean))];
  const pool = postgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const key of keys) {
      await client.query(`DELETE FROM plank_foreign_rarity WHERE chain_slug = $1 AND collection_slug = $2`, [chainSlug, key]);
      for (const r of snapshot.byTokenId.values()) {
        await client.query(
          `INSERT INTO plank_foreign_rarity (chain_slug, collection_slug, token_id, name, score, rank, percentile, tier, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            chainSlug,
            key,
            r.tokenId,
            r.name,
            r.score,
            r.rank,
            r.percentile,
            r.tier,
            r.imageUrl ?? images?.get(r.tokenId) ?? null,
          ]
        );
      }
      await client.query(
        `INSERT INTO plank_foreign_rarity_collections (chain_slug, collection_slug, sample_size, trait_index, partial, indexed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (chain_slug, collection_slug) DO UPDATE SET
           sample_size = EXCLUDED.sample_size, trait_index = EXCLUDED.trait_index,
           partial = EXCLUDED.partial, indexed_at = NOW()`,
        [chainSlug, key, snapshot.sampleSize, JSON.stringify(traitIndex), Boolean(snapshot.partial)]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
