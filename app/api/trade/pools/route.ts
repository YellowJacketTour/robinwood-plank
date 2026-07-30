import { publicError, publicJson, rateLimit } from "@/lib/security";
import { getPlankPools } from "@/lib/plank-pools";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * All $PLANK trading venues + aggregate liquidity/volume, proxied from
 * DexScreener's token endpoint. Token-level view across every pool — a
 * different concern from /api/trade/price-history, which is scoped to the
 * single pool the candle chart tracks. The client never calls DexScreener
 * directly; this route owns the upstream call and the cache in
 * lib/plank-pools.ts.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "trade-pools",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;

  try {
    const summary = await getPlankPools();
    return publicJson({
      pools: summary.pools,
      totalLiquidityUsd: summary.totalLiquidityUsd,
      totalVolumeUsd24h: summary.totalVolumeUsd24h,
      fetchedAt: summary.fetchedAt,
      stale: summary.stale ?? false,
    });
  } catch (err) {
    return publicError(err, "Could not load $PLANK pool list.");
  }
}
