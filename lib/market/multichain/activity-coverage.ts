import { postgresQuery } from "@/lib/postgres";
import { durableKv } from "@/lib/market/durable-kv";
import { enqueueDataJob } from "@/lib/market/multichain/control-plane";
import { DEMAND_PRIORITY } from "@/lib/market/multichain/collection-demand";
import { UNION_SQL } from "./ledger-union-sql";

/**
 * The activity feed's coverage count, computed OFF the request path.
 *
 * "How many events does the ledger hold for this collection, per venue, and
 * over what span" is a COUNT over every row the collection ever had. On
 * production's plank_market_events (167M rows, 110 GB, measured 2026-09-14)
 * that count for a large collection exceeds the web process's 15 s
 * statement_timeout -- it was the 500 on BAYC, Beezie and Azuki after the
 * feed itself had already been bounded.
 *
 * So the count runs in the mesh worker (80 s statement budget, no viewer
 * waiting), lands in the durable KV, and the request path only READS it.
 * Freshness is decided by evidence, not by a timer: the feed already knows
 * its newest event; if that is newer than the count's newest, rows have
 * arrived since the count and a recount is requested (deduplicated by job
 * key). No interval to tune, no cap on how many rows a count may cover.
 */

export type ActivityCoverageCount = {
  indexedEvents: number;
  timestampedEvents: number;
  oldestTimestamp: string | null;
  newestTimestamp: string | null;
  byVenue: Record<string, number>;
  /** When the count was taken. */
  countedAt: string;
};

export const ACTIVITY_COVERAGE_SOURCE = "activity-coverage";

export function activityCoverageKey(chainSlug: string, contractAddress: string): string {
  return `activity-coverage:${chainSlug}:${contractAddress.toLowerCase()}`;
}

export async function readActivityCoverage(chainSlug: string, contractAddress: string): Promise<ActivityCoverageCount | null> {
  const value = await durableKv.get<ActivityCoverageCount>(activityCoverageKey(chainSlug, contractAddress));
  if (!value || typeof value !== "object" || typeof value.indexedEvents !== "number" || typeof value.countedAt !== "string") return null;
  return value;
}

/**
 * Stale means: no count, or the feed shows an event the count did not see.
 * A count whose newest equals the feed's newest is current no matter how
 * old it is -- nothing has happened since. A feed with no timestamped
 * events cannot prove anything newer, so an existing count stands.
 */
export function activityCoverageIsStale(counted: ActivityCoverageCount | null, feedNewest: Date | null): boolean {
  if (!counted) return true;
  if (!feedNewest) return false;
  if (!counted.newestTimestamp) return true;
  return feedNewest.getTime() > Date.parse(counted.newestTimestamp);
}

export async function requestActivityCoverage(chainSlug: string, contractAddress: string): Promise<void> {
  const subject = contractAddress.toLowerCase();
  await enqueueDataJob({
    jobKey: `${ACTIVITY_COVERAGE_SOURCE}:${chainSlug}:${subject}`,
    kind: `mesh-lane:${chainSlug}`,
    source: ACTIVITY_COVERAGE_SOURCE,
    chainSlug,
    subject,
    // DETAIL_PAGE, not a bare number. MEASURED live 2026-09-14: at priority
    // 40 these jobs were enqueued correctly and then NEVER claimed -- five of
    // them sat queued with 0 attempts for over four hours while the worker
    // happily completed other sources. The plain claim orders by
    // `priority DESC` and the standing lane jobs re-enqueue every tick at
    // 20-60, so a 40 is starved by construction: below BACKGROUND (50), and
    // permanently behind work that renews itself. This count is what a
    // visitor is waiting to see on a collection page, which is exactly what
    // DETAIL_PAGE (95) means in this ladder.
    priority: DEMAND_PRIORITY.DETAIL_PAGE,
  });
}

/** The worker side: the full count over the unbounded union, then the KV write. */
export async function computeAndStoreActivityCoverage(chainSlug: string, contractAddress: string): Promise<ActivityCoverageCount> {
  const contract = contractAddress.toLowerCase();
  const result = await postgresQuery<{ venue_id: string; total: string; timestamped: string; oldest: Date | null; newest: Date | null }>(
    `SELECT venue_id, COUNT(*)::text AS total, COUNT(block_timestamp)::text AS timestamped,
            MIN(block_timestamp) AS oldest, MAX(block_timestamp) AS newest
       FROM (${UNION_SQL}) AS unioned
      GROUP BY venue_id`,
    [chainSlug, contract]
  );
  const byVenue: Record<string, number> = {};
  let indexedEvents = 0;
  let timestampedEvents = 0;
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const row of result.rows) {
    const count = Number(row.total);
    byVenue[row.venue_id] = count;
    indexedEvents += count;
    timestampedEvents += Number(row.timestamped);
    if (row.oldest && (!oldest || row.oldest < oldest)) oldest = row.oldest;
    if (row.newest && (!newest || row.newest > newest)) newest = row.newest;
  }
  const counted: ActivityCoverageCount = {
    indexedEvents,
    timestampedEvents,
    oldestTimestamp: oldest?.toISOString() ?? null,
    newestTimestamp: newest?.toISOString() ?? null,
    byVenue,
    countedAt: new Date().toISOString(),
  };
  await durableKv.set(activityCoverageKey(chainSlug, contract), counted);
  return counted;
}
