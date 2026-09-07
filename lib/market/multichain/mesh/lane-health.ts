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

export type ChainLaneHealth = {
  /** Lane keys (`source:chain`) that are down: status 'backoff', or claimed but with no success for longer than `downAfterMs`. */
  down: Array<{ source: string; since: string | null; reason: "backoff" | "no-success" }>;
  /** Discovery/stats lanes seen for this chain at all. */
  lanes: Array<{ source: string; lastClaimAt: string | null; lastSuccessAt: string | null; status: string }>;
};

/** Sources whose being down is worth a chain-tab banner: they are the ones that bring rows or floors in. */
const BANNER_SOURCES = new Set([
  "hypersync-discovery", "helius-discovery", "magiceden-catalog", "magiceden-alias", "unisat-discovery", "ordiscan-discovery", "robinhood-discovery",
  "opensea-stats", "opensea-bulk", "coingecko-nft", "adapter-sync", "unisat-collections", "bestinslot-stats", "native-robinwood", "cryptopunks-native",
]);

/**
 * AUDIT lens 1 #9 (2026-09-06, Batch E6): pure summarizer (unit-tested) that
 * turns the raw lane rows into a per-chain "what is down and since when"
 * so the hub can render "discovery source X down since T" instead of a
 * small count that looks complete. A lane is down when the scheduler
 * marked it 'backoff' (last child failed) or when it has been claimed
 * but has produced no success for longer than `downAfterMs`. A lane
 * that has never been claimed is not reported: we cannot honestly say
 * it is "down since" anything.
 */
export function summarizeLaneHealthByChain(
  rows: LaneHealthRow[],
  opts: { now?: number; downAfterMs?: number } = {}
): Record<string, ChainLaneHealth> {
  const now = opts.now ?? Date.now();
  const downAfterMs = opts.downAfterMs ?? 3 * 60 * 60_000;
  const out: Record<string, ChainLaneHealth> = {};
  for (const row of rows) {
    const idx = row.laneKey.indexOf(":");
    if (idx <= 0) continue;
    const source = row.laneKey.slice(0, idx);
    const chainSlug = row.laneKey.slice(idx + 1);
    if (!BANNER_SOURCES.has(source)) continue;
    const entry = (out[chainSlug] ??= { down: [], lanes: [] });
    entry.lanes.push({ source, lastClaimAt: row.lastClaimAt, lastSuccessAt: row.lastSuccessAt, status: row.status });
    if (!row.lastClaimAt) continue;
    if (row.status === "backoff") {
      entry.down.push({ source, since: row.lastSuccessAt ?? row.lastClaimAt, reason: "backoff" });
      continue;
    }
    const lastOk = row.lastSuccessAt ? Date.parse(row.lastSuccessAt) : NaN;
    const lastClaim = Date.parse(row.lastClaimAt);
    const anchor = Number.isFinite(lastOk) ? lastOk : lastClaim;
    if (Number.isFinite(anchor) && now - anchor > downAfterMs) {
      entry.down.push({ source, since: new Date(anchor).toISOString(), reason: "no-success" });
    }
  }
  return out;
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
