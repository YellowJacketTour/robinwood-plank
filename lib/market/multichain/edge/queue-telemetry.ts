import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";

/**
 * Honest queue and jail telemetry for /api/market/rpc-usage and the HUD:
 * real backlog depth per chain/source, a throughput-derived ETA (null when
 * nothing has completed recently -- never a fabricated "soon"), currently
 * jailed source×chain keys from the durable KV, and rate-limit incidents per
 * day from the provider ledger.
 */

export type QueueBacklogRow = { chainSlug: string; source: string; queued: number; running: number; failed: number; oldestQueuedAgeSec: number | null; maxPriority: number | null };

export type QueueTelemetry = {
  totals: { queued: number; running: number; failed: number; succeededLast15m: number };
  /** Jobs completed per minute over the last 15 minutes. */
  throughputPerMin: number | null;
  /** queued / throughput, in minutes; null when throughput is 0. */
  etaMinutes: number | null;
  backlog: QueueBacklogRow[];
  jailed: Array<{ key: string; source: string; chainSlug: string | null; remainingSec: number }>;
  rateLimitIncidents: Array<{ day: string; source: string; incidents: number }>;
  note: string;
};

export async function readQueueTelemetry(): Promise<QueueTelemetry | null> {
  if (!hasPostgresConfig()) return null;
  const [totals, recent, backlog, jails, incidents] = await Promise.all([
    postgresQuery<{ status: string; n: string }>(`SELECT status, COUNT(*)::text n FROM plank_data_jobs WHERE status IN ('queued','running','failed') GROUP BY status`),
    postgresQuery<{ n: string }>(`SELECT COUNT(*)::text n FROM plank_data_jobs WHERE status = 'succeeded' AND completed_at >= NOW() - INTERVAL '15 minutes'`),
    postgresQuery<{ chain_slug: string | null; source: string; queued: string; running: string; failed: string; oldest: string | null; max_priority: string | null }>(
      `SELECT chain_slug, source,
              COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
              COUNT(*) FILTER (WHERE status = 'running')::text AS running,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
              EXTRACT(EPOCH FROM (NOW() - MIN(not_before) FILTER (WHERE status = 'queued')))::text AS oldest,
              MAX(priority) FILTER (WHERE status = 'queued')::text AS max_priority
         FROM plank_data_jobs
        WHERE status IN ('queued','running','failed')
        GROUP BY chain_slug, source
        ORDER BY COUNT(*) FILTER (WHERE status = 'queued') DESC
        LIMIT 60`
    ),
    postgresQuery<{ key_name: string; value: unknown }>(`SELECT key_name, value FROM plank_kv_values WHERE key_name LIKE 'plank:market:source-jail-until:%'`),
    postgresQuery<{ day: string; source: string; incidents: string }>(
      `SELECT to_char(date_trunc('day', minute_start), 'YYYY-MM-DD') AS day, source, SUM(rate_limited)::text AS incidents
         FROM plank_provider_ledger
        WHERE minute_start >= NOW() - INTERVAL '7 days' AND rate_limited > 0
        GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC LIMIT 60`
    ),
  ]);
  const byStatus = Object.fromEntries(totals.rows.map((r) => [r.status, Number(r.n)]));
  const succeeded = Number(recent.rows[0]?.n ?? 0);
  const throughput = succeeded / 15;
  const queued = byStatus.queued ?? 0;
  const now = Date.now();
  const jailed = jails.rows
    .map((r) => {
      const until = typeof r.value === "number" ? r.value : Number(r.value);
      const rest = r.key_name.slice("plank:market:source-jail-until:".length);
      const [source, chainSlug] = rest.includes(":") ? [rest.slice(0, rest.indexOf(":")), rest.slice(rest.indexOf(":") + 1)] : [rest, null];
      return { key: r.key_name, source, chainSlug, remainingSec: Math.round((until - now) / 1000) };
    })
    .filter((j) => Number.isFinite(j.remainingSec) && j.remainingSec > 0)
    .sort((a, b) => b.remainingSec - a.remainingSec);
  return {
    totals: { queued, running: byStatus.running ?? 0, failed: byStatus.failed ?? 0, succeededLast15m: succeeded },
    throughputPerMin: succeeded > 0 ? Number(throughput.toFixed(2)) : null,
    etaMinutes: succeeded > 0 ? Number((queued / throughput).toFixed(1)) : null,
    backlog: backlog.rows.map((r) => ({
      chainSlug: r.chain_slug ?? "",
      source: r.source,
      queued: Number(r.queued),
      running: Number(r.running),
      failed: Number(r.failed),
      oldestQueuedAgeSec: r.oldest != null ? Math.round(Number(r.oldest)) : null,
      maxPriority: r.max_priority != null ? Number(r.max_priority) : null,
    })),
    jailed,
    rateLimitIncidents: incidents.rows.map((r) => ({ day: r.day, source: r.source, incidents: Number(r.incidents) })),
    note: "ETA = queued / (jobs succeeded in the last 15 min / 15); null when nothing completed -- the mesh is not running or is fully jailed.",
  };
}
