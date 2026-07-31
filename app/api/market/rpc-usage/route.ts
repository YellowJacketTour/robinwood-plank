import { publicError, publicJson, rateLimit } from "@/lib/security";
import { projectedMonthlyCu, readRpcMeter } from "@/lib/market/rpc-meter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Outbound JSON-RPC compute-unit usage for this process.
 *
 * Per-process, not fleet-wide: Passenger runs several workers and each keeps
 * its own counter, so multiply by worker count for a fleet estimate. This is a
 * "which code path is expensive" tool, not a billing ledger — the provider
 * dashboard remains the authority on the actual bill.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "rpc-usage", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const snapshot = readRpcMeter();
    const elapsedMs = Date.now() - snapshot.since;
    const byMethod = Object.entries(snapshot.byMethod)
      .sort((a, b) => b[1].computeUnits - a[1].computeUnits)
      .map(([method, v]) => ({ method, ...v }));

    const { hit, miss, coalesced } = snapshot.cache;
    const served = hit + miss + coalesced;

    return publicJson({
      since: new Date(snapshot.since).toISOString(),
      elapsedSeconds: Math.round(elapsedMs / 1000),
      calls: snapshot.calls,
      computeUnits: snapshot.computeUnits,
      /** Reads absorbed before reaching the provider. */
      cache: {
        ...snapshot.cache,
        served,
        avoidedPct: served > 0 ? Number((((hit + coalesced) / served) * 100).toFixed(1)) : null,
      },
      cuPerSecond:
        elapsedMs > 0 ? Number((snapshot.computeUnits / (elapsedMs / 1000)).toFixed(2)) : null,
      projectedMonthlyCu: projectedMonthlyCu(snapshot),
      /** Alchemy free tier allowance, for context on the projection. */
      freeTierMonthlyCu: 30_000_000,
      byMethod,
      note: "Per-process counter. Multiply by worker count for a fleet estimate.",
    });
  } catch (err) {
    return publicError(err, "Could not read RPC usage.");
  }
}
