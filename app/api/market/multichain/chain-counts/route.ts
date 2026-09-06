import { NextRequest, NextResponse } from "next/server";
import { hasMultichainStore, getChainCounts } from "@/lib/market/multichain/store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real, total, ALWAYS-correct per-chain collection counts across the WHOLE
 * catalog -- `SELECT chain_slug, COUNT(*) FROM plank_multichain_collections
 * GROUP BY chain_slug`, independent of any page/limit/offset. Dedicated
 * endpoint rather than a field bolted onto /api/market/multichain: that
 * route's own response is a bounded, ranked WINDOW (see its header) and
 * mixing a whole-catalog aggregate into it would either force it to always
 * run this extra query (fine, it's cheap -- ~115ms confirmed live via
 * EXPLAIN ANALYZE at ~320k rows) or awkwardly gate it behind a param; a
 * separate, tiny, independently-cacheable endpoint is the cleaner shape
 * given GlobalMarketHub.tsx already fetches chain badges and the paginated
 * catalog window on separate cadences.
 *
 * This is what the Global Market Hub's chain-tab badges must read -- not a
 * client-side count over whatever single bounded page happens to be loaded.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-chain-counts", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  if (!hasMultichainStore()) {
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const counts = await getChainCounts();
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return NextResponse.json(
      { counts, total },
      { headers: { "Cache-Control": "public, max-age=10, s-maxage=10, stale-while-revalidate=30" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load chain counts.");
  }
}
