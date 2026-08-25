/**
 * Real, no-log-watching-required lane health -- Unified Mesh Continuum
 * build item #2 (docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-
 * 2026-08-26.md). Two real, honest signals only:
 *  - last_claim_at: this lane's job was actually claimed from
 *    plank_data_jobs (proves the scheduler is alive and this lane isn't
 *    silently starved).
 *  - last_success_at: the spawned mesh-lane.ts child process for this
 *    lane actually exited 0 (proves the lane isn't permanently erroring).
 *
 * Deliberately does NOT claim to know "real progress" (rows written,
 * cursor advanced) -- that varies per lane's own output shape across 44
 * real lanes and would require parsing free-form stdout per script to
 * report honestly. Reporting a `consecutive_empty`/progress signal without
 * that real per-lane parsing would be exactly the kind of fabricated
 * status this app's own rules forbid. Callers that need real progress
 * still have the real per-domain source (collection_archival_stats,
 * plank_seaport_fill_cursor, etc.) -- this table is scheduler-liveness
 * only, not a progress oracle.
 */
import { postgresQuery } from "@/lib/postgres";

export async function recordLaneClaim(laneKey: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO mesh_lane_health (lane_key, last_claim_at, status, updated_at)
     VALUES ($1, now(), 'ok', now())
     ON CONFLICT (lane_key) DO UPDATE SET
       last_claim_at = now(),
       updated_at = now()`,
    [laneKey]
  ).catch(() => {
    // Best-effort observability only -- never block a real claim on this.
  });
}

export async function recordLaneOutcome(laneKey: string, success: boolean): Promise<void> {
  await postgresQuery(
    `UPDATE mesh_lane_health
     SET last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
         status = CASE WHEN $2 THEN 'ok' ELSE 'backoff' END,
         updated_at = now()
     WHERE lane_key = $1`,
    [laneKey, success]
  ).catch(() => {});
}

export type LaneHealthRow = {
  laneKey: string;
  lastClaimAt: string | null;
  lastSuccessAt: string | null;
  status: string;
};

/** Real read for an admin/observability view -- never used to gate real work. */
export async function getLaneHealth(): Promise<LaneHealthRow[]> {
  const result = await postgresQuery<{
    lane_key: string;
    last_claim_at: string | null;
    last_success_at: string | null;
    status: string;
  }>(`SELECT lane_key, last_claim_at, last_success_at, status FROM mesh_lane_health ORDER BY lane_key`);
  return result.rows.map((r) => ({
    laneKey: r.lane_key,
    lastClaimAt: r.last_claim_at,
    lastSuccessAt: r.last_success_at,
    status: r.status,
  }));
}

/** Lanes whose last real claim is older than `staleAfterMs` -- a lane that
 * should be claimed regularly (it's in MESH_LANES) but hasn't been in a
 * while is either jailed for an unusually long time, starved by
 * concurrency pressure, or the supervisor itself is down (the real
 * 2026-08-24 incident this whole health table traces back to). */
export async function getStalledLaneKeys(staleAfterMs: number): Promise<string[]> {
  const result = await postgresQuery<{ lane_key: string }>(
    `SELECT lane_key FROM mesh_lane_health
     WHERE last_claim_at IS NOT NULL AND last_claim_at < now() - ($1::double precision * interval '1 millisecond')`,
    [staleAfterMs]
  );
  return result.rows.map((r) => r.lane_key);
}
