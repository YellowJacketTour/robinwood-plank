import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isBitcoinChainSlug, isRobinhoodChainSlug, isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { CRYPTOPUNKS_CONTRACT } from "@/lib/market/multichain/native-market-adapters/cryptopunks";
import { postgresQuery } from "@/lib/postgres";

function normalizeCollectionKey(collectionKey: string): string {
  return /^0x[0-9a-f]{40}$/i.test(collectionKey) ? collectionKey.toLowerCase() : collectionKey;
}

/**
 * The real hydration job kinds worth (re-)queuing for one collection key on
 * one chain, with each source's OWN base priority for the plain "someone
 * just opened this collection's page" path (prioritizeCollectionDemand).
 * Extracted from the old inline `add()` closure so prioritizeVisibleCollections
 * below (which wants a DIFFERENT, viewport-driven priority for the exact
 * same job set) can share this list instead of re-deriving the chain
 * branching a second time and risking the two falling out of sync.
 */
function hydrationJobSources(
  chainSlug: string,
  normalized: string
): Array<{ source: Parameters<typeof enqueueDataJob>[0]["source"]; basePriority: number }> {
  const list: Array<{ source: Parameters<typeof enqueueDataJob>[0]["source"]; basePriority: number }> = [];
  if (isBitcoinChainSlug(chainSlug)) {
    list.push({ source: "unisat-membership", basePriority: 98 }, { source: "unisat-rarity", basePriority: 97 });
  } else if (isSolanaChainSlug(chainSlug)) {
    list.push({ source: "helius-membership", basePriority: 98 }, { source: "magiceden-solana", basePriority: 96 });
  } else if (isRobinhoodChainSlug(chainSlug)) {
    list.push(
      { source: "robinhood-membership", basePriority: 98 },
      { source: "evm-metadata", basePriority: 97 },
      { source: "opensea-stats", basePriority: 96 }
    );
  } else if (foreignChainByChainSlug(chainSlug)) {
    list.push(
      { source: "opensea-membership", basePriority: 98 },
      { source: "evm-metadata", basePriority: 97 },
      { source: "opensea-stats", basePriority: 96 }
    );
    if (chainSlug === "eth-mainnet" && normalized === CRYPTOPUNKS_CONTRACT) {
      list.push({ source: "cryptopunks-native", basePriority: 100 });
    }
  }
  return list;
}

/**
 * Turn anonymous collection demand into durable shared work. Requests never
 * perform provider fan-out; the mesh deduplicates these keys and every later
 * visitor reads the resulting PostgreSQL projection.
 */
export async function prioritizeCollectionDemand(chainSlug: string, collectionKey: string): Promise<void> {
  const normalized = normalizeCollectionKey(collectionKey);
  const jobs = hydrationJobSources(chainSlug, normalized).map(({ source, basePriority }) => ({
    jobKey: `demand:${source}:${chainSlug}:${normalized}`,
    kind: `mesh-lane:${chainSlug}`,
    source,
    chainSlug,
    subject: normalized,
    priority: basePriority,
  }));
  await Promise.all(jobs.map((job) => enqueueDataJob(job))).then(() => undefined);
}

/**
 * Viewport-aware continuous hydration (docs/marketplank/GROK-FINDINGS-
 * viewport-predictive-hydration-2026-08-25.md). This is ATTENTION-DRIVEN
 * CAPACITY ALLOCATION, not a new data source: it only changes the ORDER in
 * which the existing mesh queue (plank_data_jobs, see control-plane.ts)
 * works through collections that are already eligible for a real
 * membership/rarity/stats refresh -- it never calls a third-party provider
 * directly, never bypasses lib/market/multichain/singleflight-cache.ts or
 * freshness-budget.ts for any live user-facing read, and never flips a
 * venue's registered `coverage` classification (see venue-registry.ts) from
 * "partial" to "indexed". A collection on someone's screen right now gets
 * first claim on limited free-tier hydration; it does not become more
 * "real" or more "indexed" than the venue actually proves it to be.
 */
export const DEMAND_PRIORITY = {
  /** Existing background/mesh cadence (e.g. scheduled catalog re-syncs). Always the floor -- attention must win without needing to literally starve the mesh (aging + caps below prevent permanent lockout of anything). */
  BACKGROUND: 50,
  /** Existing single-collection "someone opened this exact page" path (prioritizeCollectionDemand's own basePriority values, 96-100) lives in this band. */
  DETAIL_PAGE: 95,
  /** A collection currently intersecting the viewport, not yet stale past its own target freshness TTL. */
  VISIBLE: 110,
  /** Visible AND still stale after waiting -- see computeVisibilityPriority's aging schedule below. Hard ceiling; nothing from this path ever outranks a real detail-page click by more than this. */
  VISIBLE_STALE_AGED: 120,
  /** Cheap same-chain rank-adjacency / related-rail / movers-strip "likely next" expansion (section 7 of the design doc) -- deliberately below plain VISIBLE. */
  PREDICT_NEXT: 100,
} as const;

const MAX_VISIBLE_KEYS = 40;
const MAX_EXPANDED_KEYS = 50;
/** How long a real hydrate is considered "fresh enough" before a still-visible collection starts aging up in priority again. Matches this app's own typical stats-refresh cadence (see e.g. the 8s/45s swr windows most multichain routes already use for a much shorter *client* cache -- this is the much coarser *mesh re-hydrate* cadence, not that). */
const TARGET_FRESH_TTL_MS = 10 * 60_000;
/** "+1 every 2 minutes waiting, cap +10" -- the design doc's exact aging schedule (section 4). */
const AGING_STEP_MINUTES = 2;
const AGING_MAX_BOOST = 10;

/**
 * Pure aging-boost calculation -- exported and unit-tested on its own
 * (test/market/collection-demand-visibility.test.ts) because it's the one
 * piece of real, non-trivial arithmetic in this whole feature. Mirrors the
 * design doc's section 4 pseudocode exactly:
 *
 *   base = VISIBLE (110)
 *   if last_hydrated_at is null OR age(last_hydrated_at) > target_fresh_ttl:
 *     minutes_waiting = age(last_visible_at) in minutes  // or first_visible_at if never hydrated
 *     boost = min(10, floor(minutes_waiting / 2))
 *     priority = min(120, base + boost)
 *   else:
 *     priority = VISIBLE
 *
 * `firstVisibleAt`/`lastVisibleAt` must be the row's values from BEFORE this
 * visibility ping touches them (i.e. read-then-update, not update-then-read)
 * -- otherwise "how long has this been waiting" would always read as zero
 * because the same call just stamped last_visible_at to now.
 */
export function computeVisibilityPriority(input: {
  lastHydratedAt: Date | null;
  firstVisibleAt: Date;
  lastVisibleAt: Date;
  now?: Date;
}): number {
  const now = input.now ?? new Date();
  const stale = input.lastHydratedAt == null || now.getTime() - input.lastHydratedAt.getTime() > TARGET_FRESH_TTL_MS;
  if (!stale) return DEMAND_PRIORITY.VISIBLE;
  const anchor = input.lastHydratedAt == null ? input.firstVisibleAt : input.lastVisibleAt;
  const minutesWaiting = Math.max(0, (now.getTime() - anchor.getTime()) / 60_000);
  const boost = Math.min(AGING_MAX_BOOST, Math.floor(minutesWaiting / AGING_STEP_MINUTES));
  return Math.min(DEMAND_PRIORITY.VISIBLE_STALE_AGED, DEMAND_PRIORITY.VISIBLE + boost);
}

/**
 * Normalize, dedupe (case-insensitive for 0x-shaped EVM addresses, matching
 * prioritizeCollectionDemand's own normalization), drop blanks, and cap at
 * `cap` entries -- order-preserving (first occurrence wins), so a client
 * that sends its most-recently-intersected keys first keeps those.
 */
export function dedupeAndCapKeys(keys: string[], cap: number = MAX_VISIBLE_KEYS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizeCollectionKey(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Rank-adjacency "predict next" expansion (design doc section 7): given the
 * page's current full sort order and the subset actually visible right now,
 * include the +/-`radius` neighbors of each visible key. Same-chain only by
 * construction -- `pageOrder` is expected to already be one chain's own
 * ordering (the caller/route is scoped to one chainSlug). No ML, no
 * collaborative filtering, just an array-index lookup.
 */
export function expandRankAdjacency(visibleKeys: string[], pageOrder: string[], radius: number = 2): string[] {
  if (pageOrder.length === 0 || visibleKeys.length === 0) return [];
  const indexOf = new Map<string, number>();
  pageOrder.forEach((k, i) => {
    if (!indexOf.has(k)) indexOf.set(k, i);
  });
  const extra = new Set<string>();
  for (const visible of visibleKeys) {
    const idx = indexOf.get(visible);
    if (idx == null) continue;
    for (let d = -radius; d <= radius; d++) {
      if (d === 0) continue;
      const neighbor = pageOrder[idx + d];
      if (neighbor) extra.add(neighbor);
    }
  }
  return [...extra];
}

type VisibilityRow = { first_visible_at: Date; last_visible_at: Date; last_hydrated_at: Date | null };

/**
 * Entry point for the viewport-visibility signal (POST /api/market/
 * multichain/visibility-demand). Dedupes/caps `collectionKeys` (the actually
 * intersecting subset), optionally expands with cheap same-chain rank
 * neighbors from `opts.pageOrder`, upserts each key's aging row in
 * collection_visibility_demand, computes its priority, and enqueues the same
 * real hydration job kinds prioritizeCollectionDemand would (via the shared
 * `hydrationJobSources` list) -- same `demand:<source>:<chain>:<key>` job
 * keys, so enqueueDataJob's own GREATEST-on-conflict upsert coalesces with
 * anything already queued rather than creating parallel duplicate work.
 *
 * DELIBERATE SCOPE LIMIT (honest, not silently dropped): the design doc's
 * step 4 says to only request a job "if your existing job kinds say they're
 * incomplete or past TTL -- don't re-queue pure no-ops." This function does
 * NOT (yet) inspect per-source completion/TTL state before enqueuing --
 * doing that correctly needs reading each of plank_collection_cells'
 * `state`/`valid_until` per source, which is real additional surface this
 * pass didn't want to touch under the "no risky changes to unrelated
 * job-processing code" instruction. Bounded instead by: max 40 keys/POST,
 * max 1 POST/2.5s/tab (client), a 30/min server IP rate limit, and
 * enqueueDataJob's existing dedup -- so the worst case is "priority churn
 * on jobs already about to run," never unbounded new work. A true
 * per-source freshness check is a real, safe follow-up.
 */
export async function prioritizeVisibleCollections(
  chainSlug: string,
  collectionKeys: string[],
  opts?: {
    context?: "rankings" | "detail" | "rail" | "movers";
    /** Full current on-page sort order for this chain, for rank-adjacency expansion. Omit to skip expansion entirely. */
    pageOrder?: string[];
    /** Default true when pageOrder is provided. */
    predictNeighbors?: boolean;
  }
): Promise<{ enqueued: number }> {
  const visible = dedupeAndCapKeys(collectionKeys, MAX_VISIBLE_KEYS);
  if (visible.length === 0) return { enqueued: 0 };

  let allKeys: string[] = visible;
  const visibleSet = new Set(visible);
  if (opts?.predictNeighbors !== false && opts?.pageOrder?.length) {
    const neighbors = expandRankAdjacency(visible, dedupeAndCapKeys(opts.pageOrder, opts.pageOrder.length));
    allKeys = dedupeAndCapKeys([...visible, ...neighbors], MAX_EXPANDED_KEYS);
  }

  const now = new Date();
  let enqueued = 0;
  for (const normalized of allKeys) {
    const isCore = visibleSet.has(normalized);
    let priority: number = isCore ? DEMAND_PRIORITY.VISIBLE : DEMAND_PRIORITY.PREDICT_NEXT;
    try {
      if (isCore) {
        const existing = await postgresQuery<VisibilityRow>(
          `SELECT first_visible_at, last_visible_at, last_hydrated_at
             FROM collection_visibility_demand
            WHERE chain_slug = $1 AND collection_key = $2`,
          [chainSlug, normalized]
        );
        const prior = existing.rows[0];
        priority = computeVisibilityPriority({
          lastHydratedAt: prior?.last_hydrated_at ?? null,
          firstVisibleAt: prior?.first_visible_at ?? now,
          lastVisibleAt: prior?.last_visible_at ?? now,
          now,
        });
      }
      await postgresQuery(
        `INSERT INTO collection_visibility_demand (chain_slug, collection_key, current_priority)
         VALUES ($1, $2, $3)
         ON CONFLICT (chain_slug, collection_key) DO UPDATE SET
           last_visible_at = NOW(),
           visible_hits = collection_visibility_demand.visible_hits + 1,
           current_priority = EXCLUDED.current_priority`,
        [chainSlug, normalized, priority]
      );
    } catch {
      // Best-effort bookkeeping: an aging-row write failure must never block
      // the real mesh enqueue below (same "side-channel, not source of
      // truth" discipline freshness-budget.ts's own recordProviderCall uses)
      // -- fall back to the un-aged base priority computed above.
    }

    const jobs = hydrationJobSources(chainSlug, normalized).map(({ source }) => ({
      jobKey: `demand:${source}:${chainSlug}:${normalized}`,
      kind: `mesh-lane:${chainSlug}`,
      source,
      chainSlug,
      subject: normalized,
      priority,
    }));
    const results = await Promise.allSettled(jobs.map((job) => enqueueDataJob(job)));
    enqueued += results.filter((r) => r.status === "fulfilled").length;
  }
  return { enqueued };
}
