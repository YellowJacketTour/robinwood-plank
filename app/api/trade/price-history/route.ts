import { publicError, publicJson, rateLimit } from "@/lib/security";
import {
  getPlankPoolStats,
  getPlankPriceHistory,
  PRICE_RANGES,
  type PriceRange,
} from "@/lib/plank-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * $PLANK price history for the /trade chart, proxied from the live
 * PLANK/WETH Uniswap pool via GeckoTerminal. This is the ERC-20 token pair —
 * a different concern from the Marketplank NFT vault, and must stay that way.
 * The client never calls GeckoTerminal directly; this route owns the upstream
 * call, the rate-limit budget, and the cache in lib/plank-price.ts.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "trade-price-history",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;

  const url = new URL(req.url);
  const rangeParam = url.searchParams.get("range")?.toUpperCase() ?? "";
  const range: PriceRange = (PRICE_RANGES as string[]).includes(rangeParam)
    ? (rangeParam as PriceRange)
    : "24H";

  try {
    const history = await getPlankPriceHistory(range);
    // Pool stats (volume/liquidity/buys-sells) are a distinct, independently
    // cached upstream call — never let a stats hiccup take the candles down
    // with it, since the chart itself doesn't need them to render.
    const stats = await getPlankPoolStats().catch(() => null);
    return publicJson({
      range,
      pool: history.poolAddress,
      network: history.network,
      fetchedAt: history.fetchedAt,
      stale: history.stale ?? false,
      candles: history.candles,
      stats,
    });
  } catch (err) {
    return publicError(err, "Could not load $PLANK price history.");
  }
}
