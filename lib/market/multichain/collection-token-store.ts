import { normalizeContractAddress } from "@/lib/market/multichain/collection-key";
import { COLLECTION_MATCH_SQL } from "@/lib/market/multichain/collection-key-sql";
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
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`,
    [input.chainSlug, input.collectionSlug]
  );
  if (!state.rows[0]) return null;
  const params: unknown[] = [input.chainSlug, input.collectionSlug];
  let where = `chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`;
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
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}
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

/** Rows per INSERT ... SELECT FROM unnest(...) statement (AUDIT lens 4 #10). */
export const PROJECTION_WRITE_CHUNK = 500;

/**
 * Merge one background-indexer page without erasing richer fields.
 * AUDIT lens 4 #10 (2026-09-06): this used to be one INSERT per token plus
 * a COUNT(*) per call; a 10k collection was ~10k round trips on a
 * 4-connection pool. Now each statement writes up to PROJECTION_WRITE_CHUNK
 * rows via `INSERT ... SELECT FROM unnest(...)`, and the collection COUNT
 * runs exactly once per batch.
 */
export async function upsertCollectionTokenProjection(
  chainSlug: string, collectionSlug: string, page: CollectionTokenProjectionPage
): Promise<void> {
  collectionSlug = normalizeContractAddress(chainSlug, collectionSlug);
  const provenance = [...new Set(page.provenance.map((value) => value.trim()).filter(Boolean))];
  if (!provenance.length) throw new Error("collection token projection requires provenance");
  if (!Number.isFinite(page.sourceObservedAt.getTime())) throw new Error("sourceObservedAt must be a valid date");
  // ON CONFLICT cannot touch the same row twice in one statement, so a
  // token id repeated within a page is merged first with the same field
  // semantics the row-level upsert applies (later non-null wins, non-empty
  // traits win) -- identical to what N sequential single-row writes produced.
  type PageToken = CollectionTokenProjectionPage["tokens"][number];
  const byId = new Map<string, PageToken>();
  for (const token of page.tokens) {
    const id = token.tokenId.trim();
    if (!id) continue;
    const prior = byId.get(id);
    if (!prior) { byId.set(id, { ...token, tokenId: id }); continue; }
    byId.set(id, {
      tokenId: id,
      name: token.name ?? prior.name,
      imageUrl: token.imageUrl ?? prior.imageUrl,
      animationUrl: token.animationUrl ?? prior.animationUrl,
      mediaType: token.mediaType ?? prior.mediaType,
      traits: normalizeTraits(token.traits).length ? token.traits : prior.traits,
      rarityScore: token.rarityScore ?? prior.rarityScore,
      rarityRank: token.rarityRank ?? prior.rarityRank,
      rarityPercentile: token.rarityPercentile ?? prior.rarityPercentile,
      rarityTier: token.rarityTier ?? prior.rarityTier,
    });
  }
  const tokens = [...byId.values()];
  await withPostgresTransaction(async (client) => {
    for (let offset = 0; offset < tokens.length; offset += PROJECTION_WRITE_CHUNK) {
      const chunk = tokens.slice(offset, offset + PROJECTION_WRITE_CHUNK);
      await client.query(
        `INSERT INTO plank_collection_tokens (
           chain_slug, collection_slug, token_id, name, image_url, animation_url, media_type, traits, rarity_score, rarity_rank,
           rarity_percentile, rarity_tier, provenance, source_observed_at, projected_at
         )
         SELECT $1, $2, u.token_id, u.name, u.image_url, u.animation_url, u.media_type, u.traits::jsonb,
                u.rarity_score, u.rarity_rank, u.rarity_percentile, u.rarity_tier, $13::text[], $14::timestamptz, NOW()
         FROM unnest(
           $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
           $9::double precision[], $10::int[], $11::double precision[], $12::text[]
         ) AS u(token_id, name, image_url, animation_url, media_type, traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier)
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
        [chainSlug, collectionSlug,
          chunk.map((t) => t.tokenId),
          chunk.map((t) => t.name ?? null),
          chunk.map((t) => t.imageUrl ?? null),
          chunk.map((t) => t.animationUrl ?? null),
          chunk.map((t) => t.mediaType ?? null),
          chunk.map((t) => JSON.stringify(normalizeTraits(t.traits))),
          chunk.map((t) => t.rarityScore ?? null),
          chunk.map((t) => t.rarityRank ?? null),
          chunk.map((t) => t.rarityPercentile ?? null),
          chunk.map((t) => t.rarityTier ?? null),
          provenance, page.sourceObservedAt]);
    }
    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM plank_collection_tokens
       WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`, [chainSlug, collectionSlug]);
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
      WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL} AND source = $3
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
  input = { ...input, collectionSlug: normalizeContractAddress(input.chainSlug, input.collectionSlug) };
  const count = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM plank_collection_tokens
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`,
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
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}
     ORDER BY token_id`, [chainSlug, collectionSlug]);
  return result.rows.map((row) => ({ tokenId: row.token_id, name: row.name, traits: normalizeTraits(row.traits) }));
}

/**
 * The complete trait index for a collection. NO ROW CEILING.
 *
 * WHY THERE IS NO LIMIT HERE
 * --------------------------
 * This query is a `CROSS JOIN LATERAL jsonb_array_elements(traits)`: it emits
 * one row per token PER TRAIT. A 10k-token collection carrying 8 traits each
 * is 80,000 rows, on a request path that /api/market/multichain/trait-index
 * serves `Cache-Control: no-store`, against a table measured at 19.4M rows /
 * 16GB, through a pool capped at PGPOOL_MAX=4.
 *
 * An earlier version of this function capped the result at an invented
 * 200,000 rows. That was the wrong instrument. A row cap is an arbitrary
 * THROUGHPUT ceiling: it decides in advance that a large collection may not
 * have a complete trait index, and the number itself was chosen by nobody for
 * no measured reason. The biggest collections are exactly the ones whose trait
 * filters matter most.
 *
 * The real hazard was never "too many rows". It was "a query that runs
 * forever holds one of four connections". That hazard is already handled, by
 * TIME rather than by row count: lib/postgres.ts sets a pool-level
 * `statement_timeout` (15s for web requests, 80s for mesh workers) with a
 * matching client `query_timeout`, so PostgreSQL cancels a runaway scan before
 * the client abandons it. A slow collection costs at most that deadline and
 * then fails cleanly -- it can never pin the pool.
 *
 * So the correct shape is: ask for everything, let the database's own deadline
 * be the only bound, and report honestly when that deadline is what stopped
 * us. Throughput is uncapped; only the clock paces it.
 *
 * WHY THE FAILURE MUST STILL BE OBSERVABLE
 * ----------------------------------------
 * A query that hits `statement_timeout` throws. If that throw were swallowed
 * into an empty result, the caller would render a trait index that is missing
 * every value and could not tell -- the "a miss that reports finished" failure
 * this codebase keeps paying for.
 *
 * So a timed-out read is reported as `incomplete: true` alongside the rows it
 * did NOT get, and `partial` is forced true regardless of what the projection
 * row claims. The caller already treats `partial` as "keep refreshing, do not
 * trust this as closed": /trait-index maps it to `building` and raises
 * collection demand. An incomplete read therefore degrades into the existing
 * work-in-progress path instead of into a confident wrong answer.
 */
export async function readProjectedTraitIndex(chainSlug: string, collectionSlug: string) {
  // The projection row is cheap and must be read even if the trait fan-out
  // times out -- it is what tells the caller the collection exists at all.
  const projection = await postgresQuery<{ projected_count: number; expected_count: number | null; partial: boolean }>(
    `SELECT projected_count, expected_count, partial FROM plank_collection_token_projections
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`, [chainSlug, collectionSlug]);
  if (!projection.rows[0]) return null;

  let rows: Array<{ token_id: string; trait_type: string; trait_value: string }> = [];
  let incomplete = false;
  try {
    const result = await postgresQuery<{ token_id: string; trait_type: string; trait_value: string }>(
      `SELECT t.token_id, trait->>'traitType' AS trait_type, trait->>'value' AS trait_value
       FROM plank_collection_tokens t
       CROSS JOIN LATERAL jsonb_array_elements(t.traits) trait
       WHERE t.chain_slug = $1 AND lower(t.collection_slug) = lower($2)
         AND COALESCE(trait->>'traitType','') <> '' AND COALESCE(trait->>'value','') <> ''`,
      [chainSlug, collectionSlug]);
    rows = result.rows;
  } catch {
    // Almost always the pool's statement_timeout. Whatever the cause, the one
    // thing we know is that we do not hold a complete index -- and saying so
    // is the entire point. Returning null instead would read as "no such
    // collection", which is a different and wrong fact.
    incomplete = true;
  }

  const traits: Record<string, Record<string, string[]>> = {};
  for (const row of rows) {
    traits[row.trait_type] ??= {};
    traits[row.trait_type][row.trait_value] ??= [];
    traits[row.trait_type][row.trait_value].push(row.token_id);
  }
  return { traits, projectedCount: Number(projection.rows[0].projected_count),
    expectedCount: projection.rows[0].expected_count == null ? null : Number(projection.rows[0].expected_count),
    // An incomplete read can never be complete, whatever the projection says.
    partial: projection.rows[0].partial || incomplete,
    incomplete };
}

export type TokenMetadataWork = { collectionSlug: string; tokenId: string };

export type GlobalTokenSearchHit = ProjectedCollectionToken & {
  chainSlug: string;
  collectionSlug: string;
};

/** One page of a global token search. `nextCursor` is non-null EXACTLY when
 * more matching rows exist beyond this page -- so a caller can always tell a
 * finished search from a truncated one, and can always continue a truncated
 * one. */
export type GlobalTokenSearchPage = {
  tokens: GlobalTokenSearchHit[];
  nextCursor: string | null;
};

/** Opaque resume key for searchProjectedTokens. Carries the FULL sort tuple,
 * not just the row identity: the search ORDER BY leads with three non-unique
 * keys (relevance bucket, enriched-first, recency), and a keyset predicate can
 * only skip what it can compare. The tuple therefore ends in the row's own
 * primary key (chain, collection, token), which is unique by definition --
 * without it, a page boundary landing inside a tie either loops on the same
 * rows or drops the rest of the tie. */
type TokenSearchCursor = {
  /** 0 = exact token_id, 1 = prefix, 2 = name/other -- the relevance bucket. */
  bucket: number;
  /** true when image_url IS NULL; unenriched rows sort after enriched ones. */
  unenriched: boolean;
  /** projected_at DESC. Carried as Postgres's OWN microsecond text rendering,
   * NOT as a JS ISO string.
   *
   * MEASURED, 2026-09-11: `new Date(row.projected_at).toISOString()` turns
   * `2026-09-12T01:20:55.210307` into `2026-09-12T01:20:55.210Z` -- JS Date has
   * millisecond resolution and silently drops the remaining microseconds. The
   * keyset's tie branch compares `projected_at = $cursor`, and that equality
   * then NEVER held, so the branch was dead code: the walk returned page one
   * and then stopped, reporting an empty page two as a finished search. 20 of
   * 137 seeded rows were reachable. That is the original defect -- an
   * unreachable tail -- recreated by its own fix, and it is invisible unless a
   * test walks to exhaustion and counts. */
  projectedAt: string;
  chainSlug: string;
  collectionSlug: string;
  tokenId: string;
};

/** Postgres's own `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.USOF')` rendering:
 * microseconds, and a 2-to-6 character numeric UTC offset. Anchored so a
 * cursor cannot smuggle arbitrary text into a ::timestamptz cast. */
const TIMESTAMP_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}[+-]\d{2}(:\d{2}){0,2}$/;

export function encodeTokenSearchCursor(c: TokenSearchCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeTokenSearchCursor(cursor: string | null | undefined): TokenSearchCursor | null {
  if (!cursor) return null;
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<TokenSearchCursor>;
    if (!Number.isFinite(p.bucket) || typeof p.unenriched !== "boolean") return null;
    // Validated by SHAPE, not by Date.parse. Postgres renders its offset as
    // `+00`, and Date.parse rejects that (it wants `+00:00` or `Z`) -- so the
    // first version of this guard threw away every cursor the store had just
    // emitted, and the walk restarted at page one forever while looking
    // perfectly healthy. The value is only ever read back by Postgres, so JS
    // date semantics have no business gating it.
    if (typeof p.projectedAt !== "string" || !TIMESTAMP_KEY_RE.test(p.projectedAt)) return null;
    if (typeof p.chainSlug !== "string" || typeof p.collectionSlug !== "string" || typeof p.tokenId !== "string") return null;
    return {
      bucket: Number(p.bucket), unenriched: p.unenriched, projectedAt: p.projectedAt,
      chainSlug: p.chainSlug, collectionSlug: p.collectionSlug, tokenId: p.tokenId,
    };
  } catch { return null; }
}

/** Page size for one global token search. This is a TRANSPORT bound -- how
 * many rows one response carries -- never a ceiling on how many rows the
 * caller may reach, because every page that fills emits a nextCursor. */
export const TOKEN_SEARCH_MAX_PAGE = 500;

/**
 * Searches the shared token projection, never an upstream provider. Exact
 * token ids rank first, then names and ids by prefix; within each relevance
 * bucket, rows with a real image_url sort ahead of not-yet-enriched rows
 * (still indexed columns, no extra computation) so a wall of "ART PENDING"
 * cards doesn't bury real enriched matches -- unenriched rows are never
 * hidden, only deprioritized. Empty queries are intentionally rejected by the
 * route.
 *
 * THE CEILING THIS REMOVED (2026-09-11)
 * -------------------------------------
 * This function used to clamp with `Math.min(Math.max(input.limit ?? 40, 1), 60)`
 * and return a bare array -- no cursor, no offset, no total. The route above it
 * hardcoded `limit: 40` and never read `?limit`, so the store's own 60 was
 * unreachable and the EFFECTIVE result of a global search over a 19.4M-row
 * projection was a flat 40 rows. Match number 41 could not be reached by any
 * request: not with a different limit, not at a different URL, not by any
 * sequence of calls. That is a ceiling, not pacing -- the same species of
 * defect as the unreachable listings tail (see
 * test/market/listings-cursor-uncapped.test.ts).
 *
 * The page bound stays, because one response must fit in one response. What
 * changed is that stopping no longer means losing: a page that fills hands
 * back the sort tuple it stopped on, and passing that back resumes from
 * exactly there. `readCollectionTokenProjection` in this same file has done
 * this since it was written; this is the same pattern applied to search.
 *
 * WHY A KEYSET AND NOT AN OFFSET: the projection is written to continuously by
 * the metadata/enrichment passes, so `projected_at` and `image_url` -- two of
 * the three leading sort keys -- change under a paging reader. OFFSET 40 on a
 * shifted result set silently skips and repeats rows; a keyset compares against
 * values the caller actually saw, so a row it already received is the only kind
 * of row it can miss.
 */
export async function searchProjectedTokens(input: {
  query: string;
  chainSlugs?: string[];
  limit?: number;
  /** Resume key from a previous page's `nextCursor`. Invalid/stale values decode
   * to null and simply start from the beginning -- never an error, never silent
   * truncation. */
  cursor?: string | null;
  /** Real faceted drill-down, all backed by columns/indexes this store already has -- never a parallel query system. */
  rarityTier?: string | null;
  /** { traitType, value } -- matches the same jsonb shape readProjectedTraitIndex already indexes via CROSS JOIN LATERAL jsonb_array_elements(traits). */
  trait?: { traitType: string; value: string } | null;
}): Promise<GlobalTokenSearchPage> {
  const query = input.query.trim();
  if (!query) return { tokens: [], nextCursor: null };
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 40), 1), TOKEN_SEARCH_MAX_PAGE);
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
  // The relevance bucket appears in the SELECT list, the ORDER BY and the
  // keyset predicate. Written once so those three can never drift apart --
  // a keyset that compares a different expression than the one it orders by
  // skips rows, and skipped rows look exactly like an empty tail.
  const bucketExpr = `CASE WHEN token_id = $1 THEN 0 WHEN token_id ILIKE $2 THEN 1 ELSE 2 END`;

  // A keyset needs a TOTAL order. The three ranking keys are all non-unique
  // (many rows share a bucket, an enriched flag, and even a projected_at from
  // the same batch write), so the tuple is completed by the row's own primary
  // key -- chain_slug, collection_slug, token_id -- which is unique by
  // definition. Without that tail a page boundary landing inside a tie would
  // either loop forever on the same rows or skip the rest of the tie.
  const cursor = decodeTokenSearchCursor(input.cursor);
  if (cursor) {
    params.push(cursor.bucket, cursor.unenriched, cursor.projectedAt, cursor.chainSlug, cursor.collectionSlug, cursor.tokenId);
    const b = `$${params.length - 5}`, u = `$${params.length - 4}`, pa = `$${params.length - 3}`;
    const cs = `$${params.length - 2}`, col = `$${params.length - 1}`, tid = `$${params.length}`;
    // Lexicographic "strictly after" over (bucket ASC, unenriched ASC,
    // projected_at DESC, chain ASC, collection ASC, token ASC). Spelled out
    // term by term rather than as a row comparison because the directions are
    // mixed, and ROW(...) > ROW(...) cannot express a DESC member.
    where += ` AND (
      (${bucketExpr}) > ${b}::int
      OR ((${bucketExpr}) = ${b}::int AND (image_url IS NULL) > ${u}::boolean)
      OR ((${bucketExpr}) = ${b}::int AND (image_url IS NULL) = ${u}::boolean AND projected_at < ${pa}::timestamptz)
      OR ((${bucketExpr}) = ${b}::int AND (image_url IS NULL) = ${u}::boolean AND projected_at = ${pa}::timestamptz
          AND (chain_slug, collection_slug, token_id) > (${cs}, ${col}, ${tid}))
    )`;
  }

  // limit + 1: the extra row is how a full page is distinguished from the last
  // page. Without it, a final page that happens to be exactly `limit` rows long
  // would emit a cursor pointing at nothing -- honest-looking and wrong.
  params.push(limit + 1);
  const result = await postgresQuery<TokenRow & { chain_slug: string; collection_slug: string; bucket: number; unenriched: boolean; projected_at_key: string }>(
    `SELECT chain_slug, collection_slug, token_id, name, image_url, animation_url,
       media_type, traits, rarity_score, rarity_rank, rarity_percentile, rarity_tier,
       to_char(projected_at, 'YYYY-MM-DD"T"HH24:MI:SS.USOF') AS projected_at_key,
       (${bucketExpr}) AS bucket, (image_url IS NULL) AS unenriched
     FROM plank_collection_tokens
     WHERE ${where}
     ORDER BY ${bucketExpr},
       (image_url IS NULL),
       projected_at DESC,
       chain_slug, collection_slug, token_id
     LIMIT $${params.length}`,
    params
  );
  const page = result.rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    tokens: page.map((row) => ({
      chainSlug: row.chain_slug, collectionSlug: row.collection_slug,
      tokenId: row.token_id, name: row.name, imageUrl: row.image_url,
      animationUrl: row.animation_url, mediaType: row.media_type,
      traits: normalizeTraits(row.traits), rarityScore: row.rarity_score,
      rarityRank: row.rarity_rank, rarityPercentile: row.rarity_percentile,
      rarityTier: row.rarity_tier,
    })),
    nextCursor: result.rows.length > limit && last
      ? encodeTokenSearchCursor({
        bucket: Number(last.bucket), unenriched: Boolean(last.unenriched),
        // Postgres's own text, straight through. Never re-serialised via Date:
        // see TokenSearchCursor.projectedAt for the microseconds that trip off
        // when it is.
        projectedAt: last.projected_at_key,
        chainSlug: last.chain_slug, collectionSlug: last.collection_slug, tokenId: last.token_id,
      })
      : null,
  };
}

export async function readTokenMetadataWork(
  chainSlug: string,
  limit: number,
  collectionSlug?: string | null
): Promise<TokenMetadataWork[]> {
  // AUDIT lens 4 #10: the 25-row cap was the throughput ceiling of the whole
  // metadata pass; a subject job may now pull up to METADATA_WORK_MAX rows.
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), METADATA_WORK_MAX);
  const params: unknown[] = [chainSlug];
  const collectionClause = collectionSlug ? `AND ${COLLECTION_MATCH_SQL}` : "";
  if (collectionSlug) params.push(collectionSlug);
  params.push(bounded);
  const limitParam = `$${params.length}`;
  // AUDIT lens 4 #3: a token past METADATA_ATTEMPT_CAP is never handed out
  // again (writeTokenMetadataResult flips it to 'empty', and rows written
  // before migration 101 with a high count are excluded here too).
  const result = await postgresQuery<{ collection_slug: string; token_id: string }>(
    `SELECT collection_slug, token_id FROM plank_collection_tokens
     WHERE chain_slug = $1 AND (
       metadata_state = 'pending'
       OR (metadata_state = 'retry' AND metadata_attempted_at < NOW() - INTERVAL '30 minutes'
           AND COALESCE(metadata_attempts, 0) < ${METADATA_ATTEMPT_CAP})
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
  // AUDIT lens 4 #3 (2026-09-06): retries are counted (migration 101) and
  // capped -- past METADATA_ATTEMPT_CAP a token becomes 'empty' with the
  // reason, instead of recycling every 30 minutes forever and blocking the
  // collection's rarity finalize.
  await postgresQuery(
    `UPDATE plank_collection_tokens SET
       metadata_attempts = CASE WHEN $4 = 'retry' THEN metadata_attempts + 1 ELSE metadata_attempts END,
       metadata_state = CASE WHEN $4 = 'retry' AND metadata_attempts + 1 >= $6 THEN 'empty' ELSE $4 END,
       metadata_attempted_at = NOW(),
       metadata_error = CASE WHEN $4 = 'retry' AND metadata_attempts + 1 >= $6 THEN 'gave up after ' || $6 || ' attempts: ' || COALESCE($5, 'unknown error') ELSE $5 END,
       projected_at = NOW()
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL} AND token_id = $3`,
    [input.chainSlug, input.collectionSlug, input.tokenId, input.state, input.error?.slice(0, 400) ?? null, METADATA_ATTEMPT_CAP]);
}

/** Retries per token before it is declared empty (AUDIT lens 4 #3). */
export const METADATA_ATTEMPT_CAP = 5;
/** Upper bound on rows one readTokenMetadataWork call may hand out. */
export const METADATA_WORK_MAX = 500;

/**
 * Honest coverage triple (AUDIT lens 4 #5): terminal (complete + empty),
 * withTraits and withImage rows against the expected population. `expected`
 * prefers the projection's expected_count (a real supply from an enumerator),
 * then the membership cursor's, then the row count itself.
 */
export type MetadataCoverageCounters = {
  expected: number;
  rows: number;
  terminal: number;
  /** Rows the fetch lane closed as confirmed-empty (dead tokenURI after the attempt cap, burned, trait-less). */
  empty: number;
  withTraits: number;
  withImage: number;
};

export async function readMetadataCoverageCounters(chainSlug: string, collectionSlug: string): Promise<MetadataCoverageCounters> {
  const result = await postgresQuery<{ rows: string; terminal: string; empty: string; with_traits: string; with_image: string; expected: string | null }>(
    `SELECT COUNT(*)::text AS rows,
            COUNT(*) FILTER (WHERE metadata_state IN ('complete','empty'))::text AS terminal,
            COUNT(*) FILTER (WHERE metadata_state = 'empty')::text AS empty,
            COUNT(*) FILTER (WHERE traits IS NOT NULL AND traits <> '[]'::jsonb)::text AS with_traits,
            COUNT(*) FILTER (WHERE image_url IS NOT NULL)::text AS with_image,
            (SELECT COALESCE(
               (SELECT expected_count FROM plank_collection_token_projections p
                 WHERE p.chain_slug = $1 AND lower(p.collection_slug) = lower($2)),
               (SELECT MAX(expected_count) FROM plank_collection_membership_cursors m
                 WHERE m.chain_slug = $1 AND lower(m.collection_slug) = lower($2))
             ))::text AS expected
     FROM plank_collection_tokens
     WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}`,
    [chainSlug, collectionSlug]);
  const row = result.rows[0];
  const rows = Number(row?.rows ?? 0);
  const expectedRaw = row?.expected == null ? null : Number(row.expected);
  // Never let a stale, too-small expected_count report >100%: expected is at
  // least the rows we actually hold.
  const expected = Math.max(rows, expectedRaw != null && Number.isFinite(expectedRaw) ? expectedRaw : 0);
  return {
    expected, rows,
    terminal: Number(row?.terminal ?? 0),
    empty: Number(row?.empty ?? 0),
    withTraits: Number(row?.with_traits ?? 0),
    withImage: Number(row?.with_image ?? 0),
  };
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
