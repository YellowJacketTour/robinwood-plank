import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

/**
 * Door-gated mesh diagnostics (2026-09-07, owner: "recent chain activity,
 * grades ... calculated wrong ... many verified checks are missing and I
 * still don't see chains getting more collections"). Queue totals alone
 * could not say WHICH lanes run, fail, or never get claimed, so every
 * diagnosis was a guess. This reads the ground truth in one call:
 * per-source job state with the last error, completions and failures in
 * the last 24h, the lane-health rows, recorded transfer activity per chain
 * over the 7-day window the hub grades on, collection counts per chain,
 * and the discovery cursors.
 */
export type MeshDiagnostics = {
  generatedAt: string;
  jobsBySource: Array<{
    source: string; chainSlug: string | null; queued: number; running: number; failed: number; succeeded: number;
    minPriority: number | null; maxPriority: number | null; maxAttempts: number | null;
    nextNotBefore: string | null; lastCompletedAt: string | null; lastError: string | null;
  }>;
  outcomes24h: Array<{ source: string; succeeded: number; failed: number; lastError: string | null }>;
  laneHealth: Array<{ laneKey: string; lastClaimAt: string | null; lastSuccessAt: string | null; status: string }>;
  activity7d: Array<{ chainSlug: string; contracts: number; transfers: number; latestDay: string | null; daysWithData: number }>;
  collectionsByChain: Array<{ chainSlug: string; total: number; withFloor: number; withName: number; newestSyncedAt: string | null }>;
  staleDemand: { queuedAtOrAbove118: number; olderThan1h: number };
  kv: Record<string, unknown>;
};

type Row = Record<string, string | null>;

export async function readMeshDiagnostics(): Promise<MeshDiagnostics | null> {
  if (!hasPostgresConfig()) return null;
  const [jobs, outcomes, lanes, activity, collections, stale, kv] = await Promise.all([
    postgresQuery<Row>(
      `SELECT source, chain_slug,
              COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
              COUNT(*) FILTER (WHERE status = 'running')::text AS running,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
              COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
              MIN(priority) FILTER (WHERE status = 'queued')::text AS min_priority,
              MAX(priority) FILTER (WHERE status = 'queued')::text AS max_priority,
              MAX(attempts)::text AS max_attempts,
              MIN(not_before) FILTER (WHERE status = 'queued')::text AS next_not_before,
              MAX(completed_at)::text AS last_completed_at,
              (ARRAY_AGG(last_error ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
         FROM plank_data_jobs
        GROUP BY source, chain_slug
        ORDER BY source, chain_slug`
    ),
    postgresQuery<Row>(
      `SELECT source,
              COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
              (ARRAY_AGG(last_error ORDER BY completed_at DESC) FILTER (WHERE status = 'failed' AND last_error IS NOT NULL))[1] AS last_error
         FROM plank_data_jobs
        WHERE completed_at >= NOW() - INTERVAL '24 hours'
        GROUP BY source ORDER BY source`
    ),
    postgresQuery<Row>(`SELECT lane_key, last_claim_at::text, last_success_at::text, status FROM mesh_lane_health ORDER BY lane_key`).catch(() => ({ rows: [] as Row[] })),
    postgresQuery<Row>(
      `SELECT chain_slug, COUNT(DISTINCT contract_address)::text AS contracts, COALESCE(SUM(transfer_count), 0)::text AS transfers,
              MAX(activity_day)::text AS latest_day, COUNT(DISTINCT activity_day)::text AS days
         FROM plank_multichain_activity_stats
        WHERE activity_day >= CURRENT_DATE - 7
        GROUP BY chain_slug ORDER BY chain_slug`
    ),
    postgresQuery<Row>(
      `SELECT c.chain_slug, COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE s.floor_price_wei IS NOT NULL)::text AS with_floor,
              COUNT(*) FILTER (WHERE c.name IS NOT NULL AND c.name <> '')::text AS with_name,
              MAX(c.synced_at)::text AS newest_synced_at
         FROM plank_multichain_collections c
         LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
        GROUP BY c.chain_slug ORDER BY c.chain_slug`
    ),
    postgresQuery<Row>(
      `SELECT COUNT(*)::text AS n, COUNT(*) FILTER (WHERE updated_at < NOW() - INTERVAL '1 hour')::text AS old
         FROM plank_data_jobs WHERE status = 'queued' AND priority >= 118`
    ),
    postgresQuery<{ key_name: string; value: unknown }>(
      `SELECT key_name, value FROM plank_kv_values
        WHERE key_name = 'plank:market:helius-collection-scan-cursor'
           OR key_name LIKE 'plank:market:hypersync%'
           OR key_name LIKE 'plank:market:magiceden-catalog%'
        LIMIT 40`
    ).catch(() => ({ rows: [] as Array<{ key_name: string; value: unknown }> })),
  ]);
  const num = (v: string | null | undefined) => (v == null ? null : Number(v));
  const err = (v: string | null | undefined) => (v ? v.slice(0, 300) : null);
  return {
    generatedAt: new Date().toISOString(),
    jobsBySource: jobs.rows.map((r) => ({
      source: r.source ?? "", chainSlug: r.chain_slug, queued: Number(r.queued), running: Number(r.running), failed: Number(r.failed), succeeded: Number(r.succeeded),
      minPriority: num(r.min_priority), maxPriority: num(r.max_priority), maxAttempts: num(r.max_attempts),
      nextNotBefore: r.next_not_before, lastCompletedAt: r.last_completed_at, lastError: err(r.last_error),
    })),
    outcomes24h: outcomes.rows.map((r) => ({ source: r.source ?? "", succeeded: Number(r.succeeded), failed: Number(r.failed), lastError: err(r.last_error) })),
    laneHealth: lanes.rows.map((r) => ({ laneKey: r.lane_key ?? "", lastClaimAt: r.last_claim_at, lastSuccessAt: r.last_success_at, status: r.status ?? "" })),
    activity7d: activity.rows.map((r) => ({ chainSlug: r.chain_slug ?? "", contracts: Number(r.contracts), transfers: Number(r.transfers), latestDay: r.latest_day, daysWithData: Number(r.days) })),
    collectionsByChain: collections.rows.map((r) => ({ chainSlug: r.chain_slug ?? "", total: Number(r.total), withFloor: Number(r.with_floor), withName: Number(r.with_name), newestSyncedAt: r.newest_synced_at })),
    staleDemand: { queuedAtOrAbove118: Number(stale.rows[0]?.n ?? 0), olderThan1h: Number(stale.rows[0]?.old ?? 0) },
    kv: Object.fromEntries(kv.rows.map((r) => [r.key_name, r.value])),
  };
}
