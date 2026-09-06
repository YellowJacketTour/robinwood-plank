import { publicError, publicJson, rateLimit } from "@/lib/security";
import { projectedMonthlyCu, readRpcMeter } from "@/lib/market/rpc-meter";
import { readProviderLedger, readInProcessLedger, flushProviderLedger } from "@/lib/market/multichain/edge/provider-ledger";
import { readEdgeStats } from "@/lib/market/multichain/edge/read-gateway";
import { readProviderBudget, PROVIDER_BUDGET_DEFAULTS } from "@/lib/market/multichain/freshness-budget";
import { hasPostgresConfig } from "@/lib/postgres";
import { readQueueTelemetry } from "@/lib/market/multichain/edge/queue-telemetry";
import { readLiveFeedStats } from "@/lib/market/multichain/edge/live-feed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live provider usage.
 *
 * Three views, each labeled with its real scope so nobody mistakes one for
 * another:
 *   - `rpc`: the per-process JSON-RPC compute-unit meter (lib/market/rpc-meter.ts).
 *   - `edge`: the per-process unified read gateway counters -- reads served
 *     vs real vendor fetches per cell (lib/market/multichain/edge/read-gateway.ts).
 *   - `ledger`: the cross-process, cross-restart provider ledger
 *     (plank_provider_ledger) -- every external call with outcome, latency,
 *     cost units and durable jail state, over the last `minutes` (default 15).
 *
 * No fabricated totals: when Postgres is not configured the ledger view is
 * the in-process buffer and says so.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "rpc-usage", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const url = new URL(req.url);
    const minutesParam = Number(url.searchParams.get("minutes") ?? "15");
    const minutes = Number.isFinite(minutesParam) ? Math.min(Math.max(Math.floor(minutesParam), 1), 90) : 15;

    const snapshot = readRpcMeter();
    const elapsedMs = Date.now() - snapshot.since;
    const byMethod = Object.entries(snapshot.byMethod)
      .sort((a, b) => b[1].computeUnits - a[1].computeUnits)
      .map(([method, v]) => ({ method, ...v }));
    const { hit, miss, coalesced } = snapshot.cache;
    const served = hit + miss + coalesced;

    // Push this process's un-flushed deltas first so the durable view is current.
    await flushProviderLedger().catch(() => 0);
    const durable = hasPostgresConfig();
    const ledgerRows = durable ? await readProviderLedger(minutes).catch(() => null) : null;
    const rows = ledgerRows ?? readInProcessLedger(minutes);

    const budgets: Record<string, unknown> = {};
    if (durable) {
      for (const provider of Object.keys(PROVIDER_BUDGET_DEFAULTS)) {
        budgets[provider] = await readProviderBudget(provider).catch(() => null);
      }
    }

    return publicJson({
      rpc: {
        since: new Date(snapshot.since).toISOString(),
        elapsedSeconds: Math.round(elapsedMs / 1000),
        calls: snapshot.calls,
        computeUnits: snapshot.computeUnits,
        cache: {
          ...snapshot.cache,
          served,
          avoidedPct: served > 0 ? Number((((hit + coalesced) / served) * 100).toFixed(1)) : null,
        },
        cuPerSecond: elapsedMs > 0 ? Number((snapshot.computeUnits / (elapsedMs / 1000)).toFixed(2)) : null,
        projectedMonthlyCu: projectedMonthlyCu(snapshot),
        freeTierMonthlyCu: 30_000_000,
        byMethod,
        note: "Per-process counter. Multiply by worker count for a fleet estimate.",
      },
      edge: readEdgeStats(),
      liveFeed: readLiveFeedStats(),
      /** Real backlog depth, throughput-derived ETA (null when nothing completes), jailed keys, rate-limit incidents per day. */
      queue: durable ? await readQueueTelemetry().catch(() => null) : null,
      ledger: {
        scope: ledgerRows ? "durable" : "in-process",
        minutes,
        rows,
        /** Current 60s Freshness Budget Controller windows per provider (live path). */
        budgets,
        note: ledgerRows
          ? "Cross-process ledger from plank_provider_ledger; jailedMs is the durable mesh jail for that source."
          : "Postgres not configured or unreachable: this is this process's own buffer only.",
      },
    });
  } catch (err) {
    return publicError(err, "Could not read provider usage.");
  }
}
