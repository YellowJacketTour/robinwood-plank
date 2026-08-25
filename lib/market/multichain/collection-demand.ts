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
export async function hydrationJobSources(
  chainSlug: string,
  normalized: string
): Promise<Array<{ source: Parameters<typeof enqueueDataJob>[0]["source"]; basePriority: number }>> {
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
      { source: "opensea-stats", basePriority: 96 },
      // Real gap found live 2026-08-25 ("while i visit this page there is
      // still no live sync"): a collection whose OpenSea enumeration has
      // plateaued (Lil Pudgys: confirmed live, its own /nfts pagination
      // looping over already-seen tokens) got ZERO benefit from a page
      // visit -- opensea-membership above just re-ran the same already-
      // stuck walk every time. anchored-membership was only ever
      // manually enqueued via a one-off script, never part of the real
      // page-visit demand set. Cheap to include unconditionally: once a
      // contract's deploy block is cached (one real HyperSync call, ever)
      // this self-limits via its own real done-check and the shared
      // HyperSync circuit breaker -- it is never wasted work, only ever
      // real, additional coverage a plain OpenSea walk cannot reach.
    );
    // Real bug found live 2026-08-25 ("no sync, no progress" on MAYC
    // despite max priority): once wired in unconditionally, an ALREADY-
    // COMPLETE collection's anchored-membership job kept getting
    // senselessly re-enqueued on every repeat page visit -- and because
    // its not_before was pinned to the earliest moment it was ever
    // enqueued (enqueueDataJob's own LEAST() ratchet), it PERMANENTLY won
    // every priority tie over every other, genuinely incomplete
    // collection's real work, forever (confirmed live: Lil Pudgys'
    // finished job claimed exclusively for 50+ minutes straight while
    // MAYC's own real, unfinished job got zero turns). Skip enqueueing
    // entirely once real, cheap evidence (one indexed read, no network
    // call) proves there is nothing left to do.
    // Real bug found live 2026-08-25 ("this isnt live time updating"):
    // this used to import from anchored-membership-backfill.ts, whose
    // top-level imports pull in the whole HyperSync native-binding
    // dependency chain -- Next.js's dev bundler can't resolve that
    // binding from an API-route execution context, so every single real
    // page visit's demand check threw "Cannot find native binding" and
    // was silently swallowed, meaning this branch always fell through as
    // if the collection were still incomplete-but-unreachable. Import
    // the dependency-free module directly instead.
    const { isAnchoredMembershipComplete } = await import("@/lib/market/multichain/discovery/anchored-membership-status");
    if (!(await isAnchoredMembershipComplete(chainSlug, normalized).catch(() => false))) {
      list.push({ source: "anchored-membership", basePriority: 95 });
    }
    // Real fix, 2026-08-25 ("it has to be stuck... was syncing fast and
    // then froze"): a SEPARATE, cheap completion check -- deliberately
    // NOT nested under anchored-membership's own flag above. The two
    // scans have independent completion criteria (this one's cursor vs
    // known_supply; anchored-membership's own provenance/transfer-ledger
    // backfill vs the real chain tip), so gating one on the other's flag
    // could stop real, still-useful work early. See token-index-probe.ts's
    // own header for why this exists alongside anchored-membership rather
    // than replacing it.
    const { isTokenIndexProbeComplete } = await import("@/lib/market/multichain/discovery/token-index-probe");
    if (!(await isTokenIndexProbeComplete(chainSlug, normalized).catch(() => false))) {
      list.push({ source: "token-index-probe", basePriority: 96 });
    }
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
  const jobs = (await hydrationJobSources(chainSlug, normalized)).map(({ source, basePriority }) => ({
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
  /** Opportunistic Archival Ledger cold frontier (docs/marketplank/GROK-
   * FINDINGS-sustainable-archival-mining-2026-08-25.md, build order item 4)
   * -- the lowest tier that exists. Strictly below BACKGROUND so a
   * never-visited collection's gap-fill hydrate can never compete with or
   * starve plain scheduled cadence, let alone anything attention-driven. */
  ARCHIVAL_FRONTIER: 10,
  /** Demand admission hardening (build order item 3): a collection key this
   * app has never resolved into plank_multichain_collections before. Above
   * ARCHIVAL_FRONTIER (an unknown key is still real, unconfirmed visitor
   * interest, more actionable than pure gap-fill) but strictly below
   * BACKGROUND, so junk/unresolved keys can never edge out real scheduled
   * cadence, let alone anything attention-driven. */
  UNKNOWN_KEY: 15,
  /** Existing background/mesh cadence (e.g. scheduled catalog re-syncs). Always the floor -- attention must win without needing to literally starve the mesh (aging + caps below prevent permanent lockout of anything). */
  BACKGROUND: 50,
  /** Opportunistic Archival Ledger bounded sibling-token expansion (build
   * order item 2): a successful single-token hydrate opportunistically
   * nudges this collection's own pending-metadata lane a little sooner,
   * deliberately below every real visitor-facing tier (DETAIL_PAGE/VISIBLE/
   * PREDICT_NEXT) so amplification never outranks a real click. */
  SIBLING_EXPAND: 70,
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
 * Real bug found live 2026-08-25 ("doesnt appear to be fast live filling",
 * MAYC still stuck despite the anchored-membership demand path itself now
 * working): confirmed live that 217 collections across every chain sat
 * PINNED at the max VISIBLE_STALE_AGED priority (120) -- most last
 * actually pinged 34+ real minutes ago (a rankings-page tab opened once
 * this session, then closed or navigated away). computeVisibilityPriority
 * has no floor on how long ago `lastVisibleAt` was real: once a
 * collection ages all the way up to the 120 ceiling, NOTHING in this
 * mechanism ever brings it back down, even after the client that made it
 * "visible" is long gone -- and because enqueueDataJob's own conflict
 * clause is `priority = GREATEST(existing, new)` (a one-way ratchet,
 * mirroring the EXACT same shape as the `not_before = LEAST(...)`
 * starvation bug fixed earlier this session for anchored-membership
 * itself), a stuck-at-120 job can never be out-prioritized by fresh,
 * real, currently-open-page demand (anchored-membership/opensea-stats/etc
 * top out around 95-100) -- it wins every single claim tie, forever,
 * exactly like Lil Pudgys' finished job did before that fix. A visibility
 * signal this old is not real anymore: a genuinely open tab re-pings far
 * more often than this (client caps at 1 POST/2.5s), so anything idle
 * this long has certainly navigated away or closed. Treat it as
 * background-tier rather than continuing to honor a stale aging boost.
 */
const STALE_VISIBILITY_MS = 90_000;

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
  // See STALE_VISIBILITY_MS's own header: a visibility ping this old is not
  // real signal anymore -- the tab that produced it is almost certainly
  // closed or navigated away, so this collection is no different from
  // plain background cadence and must not keep climbing (or holding) an
  // aged-up priority nothing is actually re-affirming.
  if (now.getTime() - input.lastVisibleAt.getTime() > STALE_VISIBILITY_MS) return DEMAND_PRIORITY.BACKGROUND;
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
 * Demand admission hardening (docs/marketplank/GROK-FINDINGS-sustainable-
 * archival-mining-2026-08-25.md section C / build order item 3): a
 * malicious or careless client can send arbitrary junk strings as
 * "collectionKeys." Keys already present in this app's own tracked-
 * collections registry (plank_multichain_collections -- populated only by
 * real discovery/scaffold paths, never by this route) are trusted at
 * normal priority; anything else is an UNKNOWN key that has never resolved
 * against a real source through this app before, and is only ever admitted
 * at a low, capped priority -- it can still eventually become tracked (a
 * genuinely new, real collection someone opens for the first time), but it
 * never gets to skip the line ahead of already-known demand.
 */
export async function partitionKnownCollectionKeys(
  chainSlug: string,
  keys: string[]
): Promise<{ known: Set<string>; unknown: Set<string> }> {
  const known = new Set<string>();
  const unknown = new Set<string>();
  if (keys.length === 0) return { known, unknown };
  const rows = await postgresQuery<{ contract_address: string }>(
    `SELECT contract_address FROM plank_multichain_collections
     WHERE chain_slug = $1 AND contract_address = ANY($2::text[])`,
    [chainSlug, keys]
  );
  const trackedSet = new Set(rows.rows.map((r) => r.contract_address));
  for (const key of keys) {
    if (trackedSet.has(key)) known.add(key);
    else unknown.add(key);
  }
  return { known, unknown };
}

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

  // Demand admission hardening (build order item 3): partition once up
  // front so the per-key loop below can cap unknown keys' priority AND
  // skip their durable collection_visibility_demand row -- an unknown key
  // never gets to accumulate "visible_hits"/aging state until it has
  // actually resolved into the real tracked-collections registry through
  // the normal discovery path.
  const { known: knownKeys } = await partitionKnownCollectionKeys(chainSlug, allKeys).catch(
    () => ({ known: new Set<string>(), unknown: new Set<string>() })
  );

  const now = new Date();
  let enqueued = 0;
  for (const normalized of allKeys) {
    const isCore = visibleSet.has(normalized);
    const isKnown = knownKeys.has(normalized);
    let priority: number = isCore ? DEMAND_PRIORITY.VISIBLE : DEMAND_PRIORITY.PREDICT_NEXT;
    if (isKnown) {
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
    } else {
      // Unknown key: never write the durable visibility/aging row, and cap
      // priority regardless of what the visible/predict-next tiers above
      // would have granted -- this is the anti-poisoning gap the findings
      // doc's section 5/C called out (a malicious client forcing hydration
      // of junk keys must not out-rank real, already-known demand).
      priority = DEMAND_PRIORITY.UNKNOWN_KEY;
    }

    const jobs = (await hydrationJobSources(chainSlug, normalized)).map(({ source }) => ({
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

/**
 * Active correction pass for the real bug documented on STALE_VISIBILITY_MS
 * above: computeVisibilityPriority's own stale check only ever runs again
 * for a key someone is STILL pinging -- a collection nobody has pinged in
 * a long while never gets recomputed at all, so it needs an explicit sweep
 * rather than relying on the read path to self-heal. Two real, separate
 * ratchet-only-up fields need correcting: collection_visibility_demand's
 * own current_priority (harmless to plain overwrite -- it's a live-state
 * column, not a conflict-resolution ratchet) and plank_data_jobs.priority
 * for any STILL-QUEUED job under one of these keys (the actual thing
 * capable of starving real demand at claim time) -- 'running' jobs are
 * deliberately left untouched, matching claimDataJob's own lease-expiry
 * reset discipline of never interrupting in-flight work.
 *
 * Cheap and safe to run on every real mesh-tick pass: one indexed read
 * (chain_slug, last_visible_at) plus, only when it finds anything, one
 * bounded UPDATE per affected chain's job rows.
 */
export async function demoteStaleVisibleDemand(): Promise<{ demoted: number }> {
  const stale = await postgresQuery<{ chain_slug: string; collection_key: string }>(
    `UPDATE collection_visibility_demand
       SET current_priority = $1
     WHERE last_visible_at < NOW() - ($2 || ' milliseconds')::interval
       AND current_priority > $1
     RETURNING chain_slug, collection_key`,
    [DEMAND_PRIORITY.BACKGROUND, STALE_VISIBILITY_MS]
  );
  if (stale.rows.length === 0) return { demoted: 0 };
  const byChain = new Map<string, string[]>();
  for (const row of stale.rows) {
    const list = byChain.get(row.chain_slug) ?? [];
    list.push(row.collection_key);
    byChain.set(row.chain_slug, list);
  }
  let demoted = 0;
  for (const [chainSlug, keys] of byChain) {
    const jobKeyPatterns = keys.map((key) => `demand:%:${chainSlug}:${key}`);
    const result = await postgresQuery(
      `UPDATE plank_data_jobs SET priority = $1, updated_at = NOW()
       WHERE status = 'queued' AND kind = $2 AND priority > $1
         AND job_key LIKE ANY($3::text[])`,
      [DEMAND_PRIORITY.BACKGROUND, `mesh-lane:${chainSlug}`, jobKeyPatterns]
    );
    demoted += result.rowCount ?? 0;
  }
  return { demoted };
}
