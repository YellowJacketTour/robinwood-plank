import { hasPostgresConfig, postgresQuery, withPostgresTransaction } from "@/lib/postgres";

export type ProjectedCollectionToken = {
  tokenId: string; name: string | null; imageUrl: string | null;
  animationUrl: string | null; mediaType: string | null;
  traits: Array<{ traitType: string; value: string }>;
  rarityScore: number | null; rarityRank: number | null;
  rarityPercentile: number | null; rarityTier: string | null;
};
export type CollectionTokenProjection = {
  tokens: ProjectedCollectionToken[]; nextCursor: string | null;
  projectedCount: number; expectedCount: number | null; partial: boolean;
  provenance: string[]; sourceObservedAt: string; projectedAt: string;
};
export type CollectionTokenProjectionPage = {
  tokens: Array<{ tokenId: string; name?: string | null; imageUrl?: string | null;
    animationUrl?: string | null; mediaType?: string | null;
    traits?: Array<{ traitType: string; value: string }>;
    rarityScore?: number | null; rarityRank?: number | null;
    rarityPercentile?: number | null; rarityTier?: string | null }>;
  expectedCount?: number | null; partial: boolean; provenance: string[]; sourceObservedAt: Date;
  preservePartial?: boolean;
};
type TokenRow = { token_id: string; name: string | null; image_url: string | null;
  animation_url: string | null; media_type: string | null;
  traits: unknown;
  rarity_score: number | null; rarity_rank: number | null;
  rarity_percentile: number | null; rarity_tier: string | null };
type ProjectionRow = { projected_count: number; expected_count: number | null; partial: boolean;
  provenance: string[]; source_observed_at: Date | string; projected_at: Date | string };

export function hasCollectionTokenStore(): boolean { return hasPostgresConfig(); }
function canonicalCollectionSlug(value: string): string {
  return /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : value;
}
type TokenCursor = { tokenId: string; rarityRank: number | null };
export function encodeTokenCursor(tokenId: string, rarityRank: number | null = null): string {
  return Buffer.from(JSON.stringify({ tokenId, rarityRank } satisfies TokenCursor), "utf8").toString("base64url");
}
export function decodeTokenCursor(cursor: string | null | undefined): TokenCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<TokenCursor>;
    if (typeof parsed.tokenId !== "string" || (parsed.rarityRank != null && !Number.isFinite(parsed.rarityRank))) return null;
    return { tokenId: parsed.tokenId, rarityRank: parsed.rarityRank == null ? null : Number(parsed.rarityRank) };
  } catch { return null; }
}

export async function readCollectionTokenProjection(input: {
  chainSlug: string; collectionSlug: string; limit: number; cursor?: string | null;
  sort?: "id" | "rank" | "rank-desc"; tier?: string | null;
}): Promise<CollectionTokenProjection | null> {
  // The browser still grows this incrementally (400/800 rows per explicit
  // load), but do not silently truncate a requested projected catalog at
  // 200. That made a healthy, fully materialized DB look incomplete.
  // This is a transport/DOM page bound, never a catalog ceiling. Every sort
  // emits a keyset cursor, so callers can traverse an arbitrarily large set.
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 800);
  const cursor = decodeTokenCursor(input.cursor);
  const sort = input.sort ?? "id";
  const tier = input.tier?.trim() || null;
  const state = await postgresQuery<ProjectionRow>(
    `SELECT projected_count, expected_count, partial, provenance, source_observed_at, projected_at
     FROM plank_collection_token_projections
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [input.chainSlug, input.collectionSlug]
  );
  if (!state.rows[0]) return null;
  const params: unknown[] = [input.chainSlug, input.collectionSlug];
  let where = "chain_slug = $1 AND lower(collection_slug) = lower($2)";
  if (tier) { params.push(tier); where += ` AND lower(rarity_tier) = lower($${params.length})`; }
  if (cursor && sort === "id") {
    params.push(cursor.tokenId);
    const cursorParam = `$${params.length}`;
    where += ` AND (
      (${cursorParam} ~ '^[0-9]+$' AND (
        (token_id ~ '^[0-9]+$' AND token_id::numeric > ${cursorParam}::numeric)
        OR token_id !~ '^[0-9]+$'
      ))
      OR (${cursorParam} !~ '^[0-9]+$' AND token_id !~ '^[0-9]+$' AND token_id > ${cursorParam})
    )`;
  } else if (cursor && sort !== "id") {
    params.push(cursor.tokenId);
    const idParam = `$${params.length}`;
    if (cursor.rarityRank == null) {
      where += ` AND rarity_rank IS NULL AND token_id > ${idParam}`;
    } else {
      params.push(cursor.rarityRank);
      const rankParam = `$${params.length}`;
      where += sort === "rank"
        ? ` AND (rarity_rank > ${rankParam} OR (rarity_rank = ${rankParam} AND token_id > ${idParam}) OR rarity_rank IS NULL)`
        : ` AND (rarity_rank < ${rankParam} OR (rarity_rank = ${rankParam} AND token_id > ${idParam}) OR rarity_rank IS NULL)`;
    }
  }
  const order = sort === "rank" ? "rarity_rank ASC NULLS LAST, token_id ASC"
    : sort === "rank-desc" ? "rarity_rank DESC NULLS LAST, token_id ASC"
      : "CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END ASC NULLS LAST, token_id ASC";
  params.push(limit + 1);
  const rows = await postgresQuery<TokenRow>(
    `SELECT token_id, name, image_url, animation_url, media_type, traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier
     FROM plank_collection_tokens WHERE ${where} ORDER BY ${order} LIMIT $${params.length}`, params);
  const page = rows.rows.slice(0, limit);
  const meta = state.rows[0];
  return {
    tokens: page.map((row) => ({ tokenId: row.token_id, name: row.name, imageUrl: row.image_url,
      animationUrl: row.animation_url, mediaType: row.media_type,
      traits: normalizeTraits(row.traits),
      rarityScore: row.rarity_score, rarityRank: row.rarity_rank,
      rarityPercentile: row.rarity_percentile, rarityTier: row.rarity_tier })),
    nextCursor: rows.rows.length > limit && page.length
      ? encodeTokenCursor(page[page.length - 1].token_id, page[page.length - 1].rarity_rank) : null,
    projectedCount: Number(meta.projected_count),
    expectedCount: meta.expected_count === null ? null : Number(meta.expected_count),
    partial: meta.partial, provenance: meta.provenance,
    sourceObservedAt: new Date(meta.source_observed_at).toISOString(),
    projectedAt: new Date(meta.projected_at).toISOString(),
  };
}

/**
 * Resolve an order-book window against the canonical token projection.
 * Books are sparse and token-id keyed, so this stays O(listed rows) even
 * when the collection universe is billions or trillions of pieces. Never
 * substitute collection-level metadata for a missing token row.
 */
export async function readProjectedTokensByIds(
  chainSlug: string,
  collectionSlug: string,
  tokenIds: string[]
): Promise<Map<string, ProjectedCollectionToken>> {
  const ids = [...new Set(tokenIds.map(String).map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return new Map();
  const rows = await postgresQuery<TokenRow>(
    `SELECT token_id, name, image_url, animation_url, media_type, traits,
            rarity_score, rarity_rank, rarity_percentile, rarity_tier
     FROM plank_collection_tokens
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)
       AND token_id = ANY($3::text[])`,
    [chainSlug, collectionSlug, ids]
  );
  return new Map(rows.rows.map((row) => [row.token_id, {
    tokenId: row.token_id,
    name: row.name,
    imageUrl: row.image_url,
    animationUrl: row.animation_url,
    mediaType: row.media_type,
    traits: normalizeTraits(row.traits),
    rarityScore: row.rarity_score,
    rarityRank: row.rarity_rank,
    rarityPercentile: row.rarity_percentile,
    rarityTier: row.rarity_tier,
  }]));
}

/** Merge one background-indexer page without erasing richer fields. */
export async function upsertCollectionTokenProjection(
  chainSlug: string, collectionSlug: string, page: CollectionTokenProjectionPage
): Promise<void> {
  collectionSlug = canonicalCollectionSlug(collectionSlug);
  const provenance = [...new Set(page.provenance.map((value) => value.trim()).filter(Boolean))];
  if (!provenance.length) throw new Error("collection token projection requires provenance");
  if (!Number.isFinite(page.sourceObservedAt.getTime())) throw new Error("sourceObservedAt must be a valid date");
  await withPostgresTransaction(async (client) => {
    for (const token of page.tokens) {
      if (!token.tokenId.trim()) continue;
      await client.query(
        `INSERT INTO plank_collection_tokens (
           chain_slug, collection_slug, token_id, name, image_url, animation_url, media_type, traits, rarity_score, rarity_rank,
           rarity_percentile, rarity_tier, provenance, source_observed_at, projected_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (chain_slug, collection_slug, token_id) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, plank_collection_tokens.name),
           image_url = COALESCE(EXCLUDED.image_url, plank_collection_tokens.image_url),
           animation_url = COALESCE(EXCLUDED.animation_url, plank_collection_tokens.animation_url),
           media_type = COALESCE(EXCLUDED.media_type, plank_collection_tokens.media_type),
           traits = CASE WHEN EXCLUDED.traits = '[]'::jsonb THEN plank_collection_tokens.traits ELSE EXCLUDED.traits END,
           rarity_score = COALESCE(EXCLUDED.rarity_score, plank_collection_tokens.rarity_score),
           rarity_rank = COALESCE(EXCLUDED.rarity_rank, plank_collection_tokens.rarity_rank),
           rarity_percentile = COALESCE(EXCLUDED.rarity_percentile, plank_collection_tokens.rarity_percentile),
           rarity_tier = COALESCE(EXCLUDED.rarity_tier, plank_collection_tokens.rarity_tier),
           provenance = ARRAY(SELECT DISTINCT unnest(plank_collection_tokens.provenance || EXCLUDED.provenance)),
           source_observed_at = GREATEST(plank_collection_tokens.source_observed_at, EXCLUDED.source_observed_at),
           projected_at = NOW()`,
        [chainSlug, collectionSlug, token.tokenId, token.name ?? null, token.imageUrl ?? null,
          token.animationUrl ?? null, token.mediaType ?? null,
          JSON.stringify(normalizeTraits(token.traits)),
          token.rarityScore ?? null, token.rarityRank ?? null, token.rarityPercentile ?? null,
          token.rarityTier ?? null, provenance, page.sourceObservedAt]);
    }
    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM plank_collection_tokens
       WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, collectionSlug]);
    await client.query(
      `INSERT INTO plank_collection_token_projections (
         chain_slug, collection_slug, projected_count, expected_count, partial,
         provenance, source_observed_at, projected_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (chain_slug, collection_slug) DO UPDATE SET
         projected_count = EXCLUDED.projected_count,
         expected_count = COALESCE(EXCLUDED.expected_count, plank_collection_token_projections.expected_count),
         partial = CASE WHEN $8 THEN plank_collection_token_projections.partial ELSE EXCLUDED.partial END,
         provenance = ARRAY(SELECT DISTINCT unnest(plank_collection_token_projections.provenance || EXCLUDED.provenance)),
         source_observed_at = GREATEST(plank_collection_token_projections.source_observed_at, EXCLUDED.source_observed_at),
         projected_at = NOW()`,
      [chainSlug, collectionSlug, Number(count.rows[0]?.count ?? 0), page.expectedCount ?? null,
        page.partial, provenance, page.sourceObservedAt, page.preservePartial ?? false]);
  });
}

export type CollectionMembershipCursor = {
  cursor: string | null; expectedCount: number | null; observedCount: number;
  complete: boolean; lastError: string | null;
};

export async function readCollectionMembershipCursor(
  chainSlug: string, collectionSlug: string, source: string
): Promise<CollectionMembershipCursor | null> {
  const result = await postgresQuery<{
    cursor: string | null; expected_count: number | null; observed_count: number;
    complete: boolean; last_error: string | null;
  }>(`SELECT cursor, expected_count, observed_count, complete, last_error
      FROM plank_collection_membership_cursors
      WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND source = $3
      ORDER BY updated_at DESC LIMIT 1`,
  [chainSlug, collectionSlug, source]);
  const row = result.rows[0];
  return row ? { cursor: row.cursor, expectedCount: row.expected_count,
    observedCount: Number(row.observed_count), complete: row.complete, lastError: row.last_error } : null;
}

export async function writeCollectionMembershipCursor(input: {
  chainSlug: string; collectionSlug: string; source: string; cursor: string | null;
  expectedCount?: number | null; complete: boolean; lastError?: string | null;
  sourceObservedAt?: Date;
}): Promise<void> {
  input = { ...input, collectionSlug: canonicalCollectionSlug(input.collectionSlug) };
  const count = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM plank_collection_tokens
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`,
    [input.chainSlug, input.collectionSlug]);
  await postgresQuery(
    `INSERT INTO plank_collection_membership_cursors (
       chain_slug, collection_slug, source, cursor, expected_count, observed_count,
       complete, last_error, source_observed_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (chain_slug, collection_slug, source) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       expected_count = COALESCE(EXCLUDED.expected_count, plank_collection_membership_cursors.expected_count),
       observed_count = EXCLUDED.observed_count,
       complete = EXCLUDED.complete,
       last_error = EXCLUDED.last_error,
       source_observed_at = COALESCE(EXCLUDED.source_observed_at, plank_collection_membership_cursors.source_observed_at),
       updated_at = NOW()`,
    [input.chainSlug, input.collectionSlug, input.source, input.cursor,
      input.expectedCount ?? null, Number(count.rows[0]?.count ?? 0), input.complete,
      input.lastError ?? null, input.sourceObservedAt ?? null]);
}

export async function readProjectedRarityInputs(chainSlug: string, collectionSlug: string) {
  const result = await postgresQuery<{ token_id: string; name: string | null; traits: unknown }>(
    `SELECT token_id, name, traits FROM plank_collection_tokens
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)
     ORDER BY token_id`, [chainSlug, collectionSlug]);
  return result.rows.map((row) => ({ tokenId: row.token_id, name: row.name, traits: normalizeTraits(row.traits) }));
}

export async function readProjectedTraitIndex(chainSlug: string, collectionSlug: string) {
  const [rows, projection] = await Promise.all([
    postgresQuery<{ token_id: string; trait_type: string; trait_value: string }>(
      `SELECT t.token_id, trait->>'traitType' AS trait_type, trait->>'value' AS trait_value
       FROM plank_collection_tokens t
       CROSS JOIN LATERAL jsonb_array_elements(t.traits) trait
       WHERE t.chain_slug = $1 AND lower(t.collection_slug) = lower($2)
         AND COALESCE(trait->>'traitType','') <> '' AND COALESCE(trait->>'value','') <> ''`,
      [chainSlug, collectionSlug]),
    postgresQuery<{ projected_count: number; expected_count: number | null; partial: boolean }>(
      `SELECT projected_count, expected_count, partial FROM plank_collection_token_projections
       WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)`, [chainSlug, collectionSlug]),
  ]);
  if (!projection.rows[0]) return null;
  const traits: Record<string, Record<string, string[]>> = {};
  for (const row of rows.rows) {
    traits[row.trait_type] ??= {};
    traits[row.trait_type][row.trait_value] ??= [];
    traits[row.trait_type][row.trait_value].push(row.token_id);
  }
  return { traits, projectedCount: Number(projection.rows[0].projected_count),
    expectedCount: projection.rows[0].expected_count == null ? null : Number(projection.rows[0].expected_count),
    partial: projection.rows[0].partial };
}

export type TokenMetadataWork = { collectionSlug: string; tokenId: string };

export type GlobalTokenSearchHit = ProjectedCollectionToken & {
  chainSlug: string;
  collectionSlug: string;
};

/**
 * Searches the shared token projection, never an upstream provider. Exact
 * token ids rank first, then names and ids by prefix. The bounded result set
 * makes this safe for the global market while the projection grows to many
 * millions of rows; empty queries are intentionally rejected by the route.
 */
export async function searchProjectedTokens(input: {
  query: string;
  chainSlugs?: string[];
  limit?: number;
  /** Real faceted drill-down, all backed by columns/indexes this store already has -- never a parallel query system. */
  rarityTier?: string | null;
  /** { traitType, value } -- matches the same jsonb shape readProjectedTraitIndex already indexes via CROSS JOIN LATERAL jsonb_array_elements(traits). */
  trait?: { traitType: string; value: string } | null;
}): Promise<GlobalTokenSearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 40), 1), 60);
  const chains = [...new Set((input.chainSlugs ?? []).map((v) => v.trim()).filter(Boolean))];
  const params: unknown[] = [query, `${query}%`];
  let where = "(token_id = $1 OR token_id ILIKE $2 OR lower(name) LIKE lower($2))";
  if (chains.length) {
    params.push(chains);
    where += ` AND chain_slug = ANY($${params.length}::text[])`;
  }
  const rarityTier = input.rarityTier?.trim() || null;
  if (rarityTier) {
    params.push(rarityTier);
    where += ` AND lower(rarity_tier) = lower($${params.length})`;
  }
  const trait = input.trait && input.trait.traitType.trim() && input.trait.value.trim() ? input.trait : null;
  if (trait) {
    params.push(trait.traitType.trim(), trait.value.trim());
    where += ` AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(traits) t
      WHERE lower(t->>'traitType') = lower($${params.length - 1}) AND lower(t->>'value') = lower($${params.length})
    )`;
  }
  params.push(limit);
  const result = await postgresQuery<TokenRow & { chain_slug: string; collection_slug: string }>(
    `SELECT chain_slug, collection_slug, token_id, name, image_url, animation_url,
       media_type, traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier
     FROM plank_collection_tokens
     WHERE ${where}
     ORDER BY CASE WHEN token_id = $1 THEN 0 WHEN token_id ILIKE $2 THEN 1 ELSE 2 END,
       projected_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    chainSlug: row.chain_slug, collectionSlug: row.collection_slug,
    tokenId: row.token_id, name: row.name, imageUrl: row.image_url,
    animationUrl: row.animation_url, mediaType: row.media_type,
    traits: normalizeTraits(row.traits), rarityScore: row.rarity_score,
    rarityRank: row.rarity_rank, rarityPercentile: row.rarity_percentile,
    rarityTier: row.rarity_tier,
  }));
}

export async function readTokenMetadataWork(
  chainSlug: string,
  limit: number,
  collectionSlug?: string | null
): Promise<TokenMetadataWork[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 25);
  const params: unknown[] = [chainSlug];
  const collectionClause = collectionSlug ? `AND lower(collection_slug) = lower($2)` : "";
  if (collectionSlug) params.push(collectionSlug);
  params.push(bounded);
  const limitParam = `$${params.length}`;
  const result = await postgresQuery<{ collection_slug: string; token_id: string }>(
    `SELECT collection_slug, token_id FROM plank_collection_tokens
     WHERE chain_slug = $1 AND (
       metadata_state = 'pending'
       OR (metadata_state = 'retry' AND metadata_attempted_at < NOW() - INTERVAL '30 minutes')
     )
     ${collectionClause}
     ORDER BY metadata_attempted_at ASC NULLS FIRST, projected_at ASC
     LIMIT ${limitParam}`, params);
  return result.rows.map((row) => ({ collectionSlug: row.collection_slug, tokenId: row.token_id }));
}

export async function writeTokenMetadataResult(input: {
  chainSlug: string; collectionSlug: string; tokenId: string;
  state: "complete" | "empty" | "retry"; error?: string | null;
}): Promise<void> {
  await postgresQuery(
    `UPDATE plank_collection_tokens SET metadata_state = $4,
       metadata_attempted_at = NOW(), metadata_error = $5, projected_at = NOW()
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2) AND token_id = $3`,
    [input.chainSlug, input.collectionSlug, input.tokenId, input.state, input.error?.slice(0, 500) ?? null]);
}

function normalizeTraits(value: unknown): Array<{ traitType: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as { traitType?: unknown; value?: unknown };
    const traitType = typeof row.traitType === "string" ? row.traitType.trim() : "";
    const traitValue = typeof row.value === "string" ? row.value.trim() : "";
    return traitType && traitValue ? [{ traitType, value: traitValue }] : [];
  });
}
