/**
 * Opportunistic Archival Ledger -- docs/marketplank/GROK-FINDINGS-
 * sustainable-archival-mining-2026-08-25.md, build order items 1, 2 and 4.
 *
 * This module never talks to a third-party provider and never writes a
 * fabricated fact. It only:
 *  - counts real, already-successful hydrate/fill writes per collection
 *    (recordArchivalHydration, called AFTER a real
 *    upsertCollectionTokenProjection succeeds -- never before), and
 *  - scores completeness honestly (computeArchivalScore /
 *    scoreFromCounts): a real ratio when known_supply is a real positive
 *    number, otherwise NULL. Never a made-up percentage.
 *  - bounds sibling-token fan-out per collection per hour
 *    (reserveSiblingExpansionSlot / nextSiblingExpansionBucket), and
 *  - selects the cold-frontier batch (selectArchivalFrontierBatch) for
 *    scripts/mesh-lane.ts's `archival-frontier` source.
 *
 * Every DB-touching function here is best-effort bookkeeping: a failure
 * must never block or fail the real hydrate/enqueue call sites that call
 * it (same "side-channel, not source of truth" discipline collection-
 * demand.ts's own visibility-row writes already follow) -- callers wrap
 * these in .catch(() => {}) rather than letting an archival-stats bug take
 * down a real hydrate response.
 */
import { postgresQuery } from "@/lib/postgres";
import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { hydrationJobSources, DEMAND_PRIORITY } from "@/lib/market/multichain/collection-demand";
import { getCollectionSupplyStats } from "@/lib/market/multichain/store";
import { readTokenMetadataWork } from "@/lib/market/multichain/collection-token-store";
import {
  nextHydrateDelayMs,
  ARCHIVAL_RECRAWL_BASE_TTL_MS,
  ARCHIVAL_RECRAWL_MIN_TTL_MS,
  ARCHIVAL_RECRAWL_MAX_TTL_MS,
} from "@/lib/market/multichain/adaptive-recrawl";

function normalizeCollectionKey(collectionKey: string): string {
  return /^0x[0-9a-f]{40}$/i.test(collectionKey) ? collectionKey.toLowerCase() : collectionKey;
}

/** Exported so callers (API routes) can build the exact same map key
 * getArchivalStatsBatch's rows come back keyed by, without duplicating the
 * normalization rule above. */
export function archivalStatsKey(chainSlug: string, collectionKey: string): string {
  return `${chainSlug}:${normalizeCollectionKey(collectionKey)}`;
}

export type ArchivalScoreMethod = "supply_ratio" | "unknown_supply";

/**
 * Pure scoring rule (docs/marketplank/GROK-FINDINGS-sustainable-archival-
 * mining-2026-08-25.md section B, "Score (fail-closed)"), exported and
 * unit-tested on its own (test/market/archival-ledger.test.ts) because it
 * is the one place a bug could fabricate a completeness percentage.
 *
 * If known_supply is a real positive finite number:
 *   score = min(1, tokens_ever_hydrated / known_supply), method='supply_ratio'.
 * Otherwise: score stays null, method='unknown_supply'. NEVER invent a %.
 */
export function scoreFromCounts(
  knownSupply: number | null,
  tokensEverHydrated: number
): { archivalScore: number | null; scoreMethod: ArchivalScoreMethod } {
  if (knownSupply != null && Number.isFinite(knownSupply) && knownSupply > 0) {
    const hydrated = Number.isFinite(tokensEverHydrated) && tokensEverHydrated > 0 ? tokensEverHydrated : 0;
    return { archivalScore: Math.min(1, hydrated / knownSupply), scoreMethod: "supply_ratio" };
  }
  return { archivalScore: null, scoreMethod: "unknown_supply" };
}

type StatsRow = { known_supply: string | null; tokens_ever_hydrated: string };

/** DB-wired wrapper around scoreFromCounts -- reads the row's own counters,
 * recomputes, and persists. Never called with client-supplied numbers. */
export async function computeArchivalScore(
  chainSlug: string,
  collectionKey: string
): Promise<{ archivalScore: number | null; scoreMethod: ArchivalScoreMethod }> {
  const normalized = normalizeCollectionKey(collectionKey);
  const result = await postgresQuery<StatsRow>(
    `SELECT known_supply::text, tokens_ever_hydrated::text FROM collection_archival_stats
     WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, normalized]
  );
  const row = result.rows[0];
  const knownSupply = row?.known_supply != null ? Number(row.known_supply) : null;
  const tokensEverHydrated = row ? Number(row.tokens_ever_hydrated) : 0;
  const { archivalScore, scoreMethod } = scoreFromCounts(knownSupply, tokensEverHydrated);
  await postgresQuery(
    `UPDATE collection_archival_stats SET archival_score = $3, score_method = $4
     WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, normalized, archivalScore, scoreMethod]
  );
  return { archivalScore, scoreMethod };
}

/**
 * Best-effort, opportunistic known_supply backfill: only ever writes a real
 * positive number this app already computed elsewhere (plank_multichain_
 * snapshots.total_supply via getCollectionSupplyStats), and only when the
 * column is still null -- never overwrites an existing value, never invents
 * one. Failures are swallowed; known_supply simply stays null and scoring
 * stays honestly 'unknown_supply'.
 */
async function backfillKnownSupplyIfMissing(chainSlug: string, collectionKey: string): Promise<void> {
  try {
    const supply = await getCollectionSupplyStats(chainSlug, collectionKey);
    if (supply?.totalSupply == null || !Number.isFinite(supply.totalSupply) || supply.totalSupply <= 0) return;
    await postgresQuery(
      `UPDATE collection_archival_stats SET known_supply = $3
       WHERE chain_slug = $1 AND collection_key = $2 AND known_supply IS NULL`,
      [chainSlug, normalizeCollectionKey(collectionKey), Math.trunc(supply.totalSupply)]
    );
  } catch {
    /* best-effort only -- scoring stays 'unknown_supply' until this succeeds */
  }
}

/**
 * One-time backfill: `collection_archival_stats` was created 2026-08-25
 * (migration 064), but `plank_collection_tokens` already held real,
 * legitimately-hydrated tokens from hours of prior background/on-demand
 * work that predates the ledger. Without this, `tokens_ever_hydrated`
 * would only ever reflect NEW growth since the ledger's own birth --
 * live-verified as a real bug: Decentraland showed `tokens_ever_hydrated:
 * 1` from the ledger while `plank_collection_tokens` already had 8,001
 * real hydrated rows (name or image_url present) out of a 93,643 supply.
 *
 * Seeds the real, already-true count once per collection, honestly:
 * counts rows with a real name/image already stored, never invents a
 * number, and only raises `tokens_ever_hydrated` (never lowers it below
 * whatever real-time counting has already accumulated since the ledger
 * went live). Safe to re-run -- it's a GREATEST(), not an overwrite.
 */
export async function backfillArchivalStatsFromExistingTokens(
  chainSlug: string,
  collectionKey: string
): Promise<{ realHydratedCount: number }> {
  const normalized = normalizeCollectionKey(collectionKey);
  const result = await postgresQuery<{ real_count: string }>(
    `SELECT COUNT(*)::text AS real_count FROM plank_collection_tokens
     WHERE chain_slug = $1 AND lower(collection_slug) = lower($2)
       AND (name IS NOT NULL OR image_url IS NOT NULL)`,
    [chainSlug, normalized]
  );
  const realHydratedCount = Number(result.rows[0]?.real_count ?? 0);
  const now = new Date();
  await postgresQuery(
    `INSERT INTO collection_archival_stats (
       chain_slug, collection_key, tokens_ever_hydrated, fills_ever_stored,
       first_archived_at, last_archived_at, organic_hits
     ) VALUES ($1, $2, $3, 0, $4, $4, 0)
     ON CONFLICT (chain_slug, collection_key) DO UPDATE SET
       tokens_ever_hydrated = GREATEST(collection_archival_stats.tokens_ever_hydrated, $3),
       first_archived_at = COALESCE(collection_archival_stats.first_archived_at, $4)`,
    [chainSlug, normalized, realHydratedCount, now]
  );
  await backfillKnownSupplyIfMissing(chainSlug, normalized);
  await computeArchivalScore(chainSlug, normalized);
  return { realHydratedCount };
}

/**
 * Build order item 1: idempotent counter upsert on every real hydrate/fill
 * success. Called AFTER upsertCollectionTokenProjection (or the equivalent
 * fill-store write) succeeds, never before -- these counters must only ever
 * reflect writes that actually landed.
 */
export async function recordArchivalHydration(
  chainSlug: string,
  collectionKey: string,
  opts?: { isNewToken?: boolean; isFill?: boolean }
): Promise<void> {
  const normalized = normalizeCollectionKey(collectionKey);
  const now = new Date();
  const tokensDelta = opts?.isNewToken ? 1 : 0;
  const fillsDelta = opts?.isFill ? 1 : 0;
  // Adaptive recrawl (Unified Mesh Continuum build item #4): honest binary
  // change detection reusing this exact isNewToken/isFill signal -- no new
  // fingerprinting, no invented volatility score. Read-then-compute-then-
  // write (one extra round trip vs. folding the formula into SQL) so
  // nextHydrateDelayMs stays the single real source of truth for the
  // backoff curve instead of a second, driftable copy in SQL.
  const changed = tokensDelta > 0 || fillsDelta > 0;
  const priorResult = await postgresQuery<{ consecutive_unchanged: number }>(
    `SELECT consecutive_unchanged FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, normalized]
  );
  const priorConsecutiveUnchanged = priorResult.rows[0]?.consecutive_unchanged ?? 0;
  const consecutiveUnchanged = changed ? 0 : priorConsecutiveUnchanged + 1;
  const delayMs = nextHydrateDelayMs({
    baseTtlMs: ARCHIVAL_RECRAWL_BASE_TTL_MS,
    minTtlMs: ARCHIVAL_RECRAWL_MIN_TTL_MS,
    maxTtlMs: ARCHIVAL_RECRAWL_MAX_TTL_MS,
    consecutiveUnchanged,
    changed,
  });
  const nextDueAt = new Date(now.getTime() + delayMs);
  await postgresQuery(
    `INSERT INTO collection_archival_stats (
       chain_slug, collection_key, tokens_ever_hydrated, fills_ever_stored,
       first_archived_at, last_archived_at, organic_hits, consecutive_unchanged, next_due_at
     ) VALUES ($1, $2, $3, $4, $5, $5, 1, $6, $7)
     ON CONFLICT (chain_slug, collection_key) DO UPDATE SET
       tokens_ever_hydrated = collection_archival_stats.tokens_ever_hydrated + $3,
       fills_ever_stored = collection_archival_stats.fills_ever_stored + $4,
       first_archived_at = COALESCE(collection_archival_stats.first_archived_at, $5),
       last_archived_at = $5,
       organic_hits = collection_archival_stats.organic_hits + 1,
       consecutive_unchanged = $6,
       next_due_at = $7`,
    [chainSlug, normalized, tokensDelta, fillsDelta, now, consecutiveUnchanged, nextDueAt]
  );
  await backfillKnownSupplyIfMissing(chainSlug, normalized);
  await computeArchivalScore(chainSlug, normalized);
}

// ---------------------------------------------------------------------------
// Build order item 2: bounded sibling-token expansion.
// ---------------------------------------------------------------------------

/** Small, deliberately conservative caps -- "bounded, budget-respecting, not
 * unbounded fan-out" per the findings doc's explicit constraint. */
export const MAX_SIBLING_EXPANSIONS_PER_HOUR = 3;
export const SIBLING_EXPANSION_BATCH_SIZE = 4;

/**
 * Pure hour-bucket budget logic, unit-tested on its own
 * (test/market/archival-ledger.test.ts): at most
 * MAX_SIBLING_EXPANSIONS_PER_HOUR sibling-expansion triggers per collection
 * per rolling hour. A bucket older than one hour resets to a fresh bucket
 * starting now (mirrors collection-demand.ts's own aging-bucket style).
 */
export function nextSiblingExpansionBucket(input: {
  bucketStart: Date | null;
  countInBucket: number;
  now: Date;
}): { allowed: boolean; newBucketStart: Date; newCount: number } {
  const bucketAgeMs = input.bucketStart ? input.now.getTime() - input.bucketStart.getTime() : Number.POSITIVE_INFINITY;
  if (bucketAgeMs >= 60 * 60_000) {
    return { allowed: true, newBucketStart: input.now, newCount: 1 };
  }
  if (input.countInBucket < MAX_SIBLING_EXPANSIONS_PER_HOUR) {
    return { allowed: true, newBucketStart: input.bucketStart as Date, newCount: input.countInBucket + 1 };
  }
  return { allowed: false, newBucketStart: input.bucketStart as Date, newCount: input.countInBucket };
}

/** DB-wired budget reservation: read-modify-write the row's own hour-bucket
 * columns. A best-effort check, not a hard distributed lock -- a rare race
 * under concurrent hydrates can only ever let one or two EXTRA sibling
 * batches (still bounded to a handful of tokens) through, never unbounded
 * fan-out. */
async function reserveSiblingExpansionSlot(chainSlug: string, collectionKey: string): Promise<boolean> {
  const normalized = normalizeCollectionKey(collectionKey);
  const now = new Date();
  const result = await postgresQuery<{ sibling_expansions_hour_bucket: Date | null; sibling_expansions_in_bucket: number }>(
    `SELECT sibling_expansions_hour_bucket, sibling_expansions_in_bucket
     FROM collection_archival_stats WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, normalized]
  );
  const row = result.rows[0];
  const decision = nextSiblingExpansionBucket({
    bucketStart: row?.sibling_expansions_hour_bucket ?? null,
    countInBucket: row?.sibling_expansions_in_bucket ?? 0,
    now,
  });
  if (!decision.allowed) return false;
  await postgresQuery(
    `UPDATE collection_archival_stats
       SET sibling_expansions_hour_bucket = $3, sibling_expansions_in_bucket = $4
     WHERE chain_slug = $1 AND collection_key = $2`,
    [chainSlug, normalized, decision.newBucketStart, decision.newCount]
  );
  return true;
}

/**
 * On a successful single-token hydrate, opportunistically widen capture:
 * if this collection's hourly sibling-expansion budget allows, boost the
 * priority of this collection's already-queued hydration lane (the SAME
 * mesh/enqueueDataJob path prioritizeCollectionDemand uses) to
 * DEMAND_PRIORITY.SIBLING_EXPAND -- LOWER than a real visible/detail-page
 * request, so the next mesh tick naturally picks up a bounded page of this
 * collection's own already-known pending token ids (readTokenMetadataWork
 * already returns the collection's real, already-tracked token rows still
 * missing metadata -- never client-supplied trait/sibling data).
 *
 * This never calls a third-party provider directly; it only nudges the
 * priority of real, already-existing job kinds so a real mesh worker picks
 * this collection's pending siblings up a little sooner than plain
 * background cadence would.
 */
export async function maybeExpandSiblingTokens(
  chainSlug: string,
  collectionKey: string
): Promise<{ expanded: boolean; siblingTokenIds: string[] }> {
  const normalized = normalizeCollectionKey(collectionKey);
  const reserved = await reserveSiblingExpansionSlot(chainSlug, normalized);
  if (!reserved) return { expanded: false, siblingTokenIds: [] };

  const pending = await readTokenMetadataWork(chainSlug, SIBLING_EXPANSION_BATCH_SIZE, normalized).catch(() => []);
  const siblingTokenIds = pending.map((item) => item.tokenId);

  const jobs = hydrationJobSources(chainSlug, normalized).map(({ source }) => ({
    jobKey: `demand:${source}:${chainSlug}:${normalized}`,
    kind: `mesh-lane:${chainSlug}`,
    source,
    chainSlug,
    subject: normalized,
    priority: DEMAND_PRIORITY.SIBLING_EXPAND,
  }));
  await Promise.allSettled(jobs.map((job) => enqueueDataJob(job)));
  return { expanded: true, siblingTokenIds };
}

// ---------------------------------------------------------------------------
// Build order item 4: cold frontier selection.
// ---------------------------------------------------------------------------

export const ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD = 0.05;
export const ARCHIVAL_FRONTIER_BATCH_SIZE = 5;
/** "Run at most once every N minutes" -- the lowest-priority, most-patient
 * part of this system deliberately does not run every tick. */
export const ARCHIVAL_FRONTIER_MIN_INTERVAL_MS = 30 * 60_000;

export type ArchivalFrontierCandidate = { chainSlug: string; collectionKey: string };

/**
 * "Pick collections with organic_hits = 0 OR archival_score IS NULL OR
 * archival_score < threshold, least-recently-archived / never-archived
 * first" (findings doc section D). Reads only collection_archival_stats --
 * a collection that has never once been hydrated (no row here at all) is
 * intentionally NOT covered by this query; item 4 explicitly scopes the
 * cold frontier to collections this ledger already knows about (rows are
 * created the first time ANY real hydrate touches a collection, which for
 * every tracked collection happens quickly via the existing demand paths).
 */
export async function selectArchivalFrontierBatch(
  limit: number = ARCHIVAL_FRONTIER_BATCH_SIZE
): Promise<ArchivalFrontierCandidate[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 25);
  const result = await postgresQuery<{ chain_slug: string; collection_key: string }>(
    // Adaptive recrawl (build item #4): a collection whose last real
    // hydration found nothing new is backed off past next_due_at, freeing
    // this cold-frontier lane's real budget for collections genuinely
    // worth re-checking instead of repeatedly re-selecting one that just
    // proved stable. NULL next_due_at (never hydrated at all) stays
    // immediately eligible -- this never delays a collection's FIRST pass.
    `SELECT chain_slug, collection_key FROM collection_archival_stats
     WHERE (organic_hits = 0 OR archival_score IS NULL OR archival_score < $2)
       AND (next_due_at IS NULL OR next_due_at <= now())
     ORDER BY last_archived_at ASC NULLS FIRST, organic_hits ASC
     LIMIT $1`,
    [bounded, ARCHIVAL_FRONTIER_LOW_SCORE_THRESHOLD]
  );
  return result.rows.map((row) => ({ chainSlug: row.chain_slug, collectionKey: row.collection_key }));
}

/**
 * Durable "last ran at" gate (its own singleton row, migration 064) so the
 * cold-frontier lane runs at most once every ARCHIVAL_FRONTIER_MIN_INTERVAL_MS
 * regardless of how often mesh-tick itself runs. Atomic claim: only the
 * caller that successfully advances last_run_at gets to actually run.
 */
export async function tryClaimArchivalFrontierRun(now: Date = new Date()): Promise<boolean> {
  const result = await postgresQuery<{ claimed: boolean }>(
    `INSERT INTO archival_frontier_runs (id, last_run_at) VALUES (true, $1)
     ON CONFLICT (id) DO UPDATE SET last_run_at = $1
     WHERE archival_frontier_runs.last_run_at IS NULL
        OR $1 - archival_frontier_runs.last_run_at >= INTERVAL '1 millisecond' * $2
     RETURNING TRUE AS claimed`,
    [now, ARCHIVAL_FRONTIER_MIN_INTERVAL_MS]
  );
  return result.rows[0]?.claimed === true;
}

/**
 * Build order item 4's actual mesh work: gated by tryClaimArchivalFrontierRun
 * (so this only ever fires at most once per ARCHIVAL_FRONTIER_MIN_INTERVAL_MS
 * across every mesh-tick invocation), select a small never/rarely-archived
 * batch and enqueue their existing hydration job kinds at a priority LOWER
 * than DEMAND_PRIORITY.BACKGROUND so this can never compete with or starve
 * real user-triggered work -- same enqueueDataJob mechanism, same real
 * per-chain job sources as every other demand path in this file.
 */
// ---------------------------------------------------------------------------
// API exposure -- collection_archival_stats was backend-only until this
// (docs/marketplank/GROK-FINDINGS-immersive-hydration-visualization-
// 2026-08-25.md, "Build decision" section: neither GlobalMarketHub's
// rankings response nor the collection-detail route exposed archival_score/
// tokens_ever_hydrated/score_method per collection). Everything below is a
// read-only, best-effort projection of the same ledger the functions above
// write to -- never a second source of truth, never a write path.
// ---------------------------------------------------------------------------

export type ArchivalApiShape = {
  archivalScore: number | null;
  scoreMethod: ArchivalScoreMethod | "hits_only";
  tokensEverHydrated: number | null;
  knownSupply: number | null;
  lastArchivedAt: string | null;
  /** Present only where the caller opted into the extra plank_data_jobs
   * lookup (see getArchivalStatsForCollection) -- omitted, never false, for
   * a batched rankings-list lookup that skipped the check entirely. */
  jobProcessing?: boolean;
};

type RawArchivalStatsRow = {
  chain_slug: string;
  collection_key: string;
  known_supply: string | null;
  tokens_ever_hydrated: string | number | null;
  archival_score: string | number | null;
  score_method: string | null;
  last_archived_at: Date | string | null;
};

/**
 * Pure row -> API-shape mapper, unit-tested on its own
 * (test/market/archival-ledger.test.ts) because it is the one place a bug
 * could silently reshape or fabricate a value on the way out to the client.
 * A missing row (no archival activity recorded yet for this collection)
 * maps to all-nulls -- never a fabricated 0 or "unknown_supply" is still an
 * honest, real score_method value, not a placeholder.
 */
export function toArchivalApiShape(row: RawArchivalStatsRow | null | undefined): ArchivalApiShape | null {
  if (!row) return null;
  const scoreMethod = (row.score_method as ArchivalScoreMethod | null) ?? "unknown_supply";
  return {
    archivalScore: row.archival_score != null ? Number(row.archival_score) : null,
    scoreMethod,
    tokensEverHydrated: row.tokens_ever_hydrated != null ? Number(row.tokens_ever_hydrated) : null,
    knownSupply: row.known_supply != null ? Number(row.known_supply) : null,
    lastArchivedAt:
      row.last_archived_at == null
        ? null
        : row.last_archived_at instanceof Date
          ? row.last_archived_at.toISOString()
          : new Date(row.last_archived_at).toISOString(),
  };
}

/**
 * Single-collection lookup for the collection-detail route -- one indexed
 * read (chain_slug, collection_key is this table's real primary key) plus,
 * cheaply, a real "is a job processing this collection right now" check
 * against plank_data_jobs.status = 'running' (the same table/status
 * control-plane.ts's own claimDataJob/finishDataJob use). Both queries are
 * trivial on a single-collection page; batching this same jobProcessing
 * check across a 5000-row rankings response would not be (see
 * getArchivalStatsBatch's own header for why that route skips it).
 */
export async function getArchivalStatsForCollection(
  chainSlug: string,
  collectionKey: string
): Promise<ArchivalApiShape | null> {
  const normalized = normalizeCollectionKey(collectionKey);
  const [statsResult, jobResult] = await Promise.all([
    postgresQuery<RawArchivalStatsRow>(
      `SELECT chain_slug, collection_key, known_supply::text, tokens_ever_hydrated::text,
              archival_score::text, score_method, last_archived_at
       FROM collection_archival_stats
       WHERE chain_slug = $1 AND collection_key = $2`,
      [chainSlug, normalized]
    ).catch(() => ({ rows: [] as RawArchivalStatsRow[] })),
    postgresQuery<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM plank_data_jobs
         WHERE status = 'running' AND chain_slug = $1 AND subject = $2
       ) AS exists`,
      [chainSlug, normalized]
    ).catch(() => ({ rows: [{ exists: false }] })),
  ]);
  const shape = toArchivalApiShape(statsResult.rows[0] ?? null);
  if (!shape) return null;
  return { ...shape, jobProcessing: jobResult.rows[0]?.exists === true };
}

/**
 * Batched lookup for the rankings list route -- ONE query for the whole
 * page (up to 5000 rows per route.ts's own bound) via `= ANY($1::text[])`
 * pairs matched back up client-side, rather than one query per collection.
 * Deliberately does NOT check plank_data_jobs here: a per-row "is this
 * collection's job running right now" lookup would mean joining or querying
 * against up to 5000 subjects on every rankings page load, and unlike the
 * single-collection route this response is already the single largest
 * regular read this app serves (see route.ts's own header on why it's
 * capped/paginated at all). jobProcessing is left undefined for every row
 * from this path -- HydrationPlankChip already treats undefined the same as
 * false (idle), so this only ever costs the "processing" glow, never a
 * wrong or fabricated answer.
 */
export async function getArchivalStatsBatch(
  pairs: Array<{ chainSlug: string; collectionKey: string }>
): Promise<Map<string, ArchivalApiShape>> {
  const out = new Map<string, ArchivalApiShape>();
  if (pairs.length === 0) return out;
  const chainSlugs = pairs.map((p) => p.chainSlug);
  const normalizedKeys = pairs.map((p) => normalizeCollectionKey(p.collectionKey));
  const result = await postgresQuery<RawArchivalStatsRow>(
    `SELECT s.chain_slug, s.collection_key, s.known_supply::text, s.tokens_ever_hydrated::text,
            s.archival_score::text, s.score_method, s.last_archived_at
     FROM collection_archival_stats s
     JOIN UNNEST($1::text[], $2::text[]) AS want(chain_slug, collection_key)
       ON s.chain_slug = want.chain_slug AND s.collection_key = want.collection_key`,
    [chainSlugs, normalizedKeys]
  ).catch(() => ({ rows: [] as RawArchivalStatsRow[] }));
  for (const row of result.rows) {
    const shape = toArchivalApiShape(row);
    if (shape) out.set(`${row.chain_slug}:${row.collection_key}`, shape);
  }
  return out;
}

/**
 * Batched "is a real job processing this collection right now" check for a
 * SMALL, caller-bounded set of pairs (the rankings table's currently
 * rendered page, up to rankingsShowCount/100 -- never the full up-to-5000
 * API response getArchivalStatsBatch itself already declines to check this
 * against). One UNNEST-joined query regardless of pair count, same shape as
 * getArchivalStatsBatch. Real fix for "i cant tell if any of the
 * collections are hydrating" (live 2026-08-26): HydrationPlankChip was
 * wired up but the rankings route always sent jobProcessing as undefined,
 * so the chip could never actually light up there.
 */
export type JobProcessingInfo = {
  /** Real plank_data_jobs.source of whichever running job for this
   * collection was seen first (a collection can have several concurrent
   * job rows -- e.g. "opensea-membership" + "evm-metadata" -- this is a
   * real one of them, not a synthesized composite). Never fabricated: this
   * IS the same source enqueueDataJob/hydrationJobSources use to name real
   * mesh-lane work. */
  source: string;
};

export async function getJobProcessingBatch(
  pairs: Array<{ chainSlug: string; collectionKey: string }>
): Promise<Map<string, JobProcessingInfo>> {
  const out = new Map<string, JobProcessingInfo>();
  if (pairs.length === 0) return out;
  const chainSlugs = pairs.map((p) => p.chainSlug);
  const normalizedKeys = pairs.map((p) => normalizeCollectionKey(p.collectionKey));
  const result = await postgresQuery<{ chain_slug: string; subject: string; source: string }>(
    `SELECT DISTINCT ON (j.chain_slug, j.subject) j.chain_slug, j.subject, j.source
     FROM plank_data_jobs j
     JOIN UNNEST($1::text[], $2::text[]) AS want(chain_slug, collection_key)
       ON j.chain_slug = want.chain_slug AND j.subject = want.collection_key
     WHERE j.status = 'running'
     ORDER BY j.chain_slug, j.subject, j.priority DESC`,
    [chainSlugs, normalizedKeys]
  ).catch(() => ({ rows: [] as Array<{ chain_slug: string; subject: string; source: string }> }));
  for (const row of result.rows) out.set(`${row.chain_slug}:${row.subject}`, { source: row.source });
  return out;
}

export async function runArchivalFrontierLane(): Promise<{ ran: boolean; enqueued: number; candidates: ArchivalFrontierCandidate[] }> {
  const claimed = await tryClaimArchivalFrontierRun();
  if (!claimed) return { ran: false, enqueued: 0, candidates: [] };
  const candidates = await selectArchivalFrontierBatch();
  let enqueued = 0;
  for (const candidate of candidates) {
    const jobs = hydrationJobSources(candidate.chainSlug, candidate.collectionKey).map(({ source }) => ({
      jobKey: `demand:${source}:${candidate.chainSlug}:${candidate.collectionKey}`,
      kind: `mesh-lane:${candidate.chainSlug}`,
      source,
      chainSlug: candidate.chainSlug,
      subject: candidate.collectionKey,
      priority: DEMAND_PRIORITY.ARCHIVAL_FRONTIER,
    }));
    const results = await Promise.allSettled(jobs.map((job) => enqueueDataJob(job)));
    enqueued += results.filter((r) => r.status === "fulfilled").length;
  }
  return { ran: true, enqueued, candidates };
}
