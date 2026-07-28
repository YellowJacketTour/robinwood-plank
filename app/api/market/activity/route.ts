import { NextResponse } from "next/server";
import { fetchActivity } from "@/lib/market/activity";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Recent on-chain activity for the collection.
 *
 * Cached in-process because every call costs a fan-out of eth_getLogs plus a
 * getTransaction per row, and the underlying data only changes as fast as the
 * chain does.
 */
const CACHE_MS = 60_000;
// full=1 (the price chart's "full lineage" mode) walks much deeper and is
// heavier per-call (see lib/market/activity.ts's FULL_LINEAGE_LIMIT
// comment) — its own longer-lived cache, separate from the default one.
const FULL_CACHE_MS = 120_000;

let cache: { at: number; events: unknown[] } | null = null;
let fullCache: { at: number; events: unknown[] } | null = null;

/** publicJson forces Cache-Control: no-store on every response — right for
 * most routes, but this one is public, non-sensitive, and read constantly
 * (ActivityFeed, ActivityStats, NftPriceChart), so browsers/CDN were never
 * allowed to reuse a response even when the server cache above was warm. */
function cachedPublicJson(data: unknown): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
  });
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const full = new URL(req.url).searchParams.get("full") === "1";

  if (full) {
    if (fullCache && Date.now() - fullCache.at < FULL_CACHE_MS) {
      return cachedPublicJson({ events: fullCache.events, cached: true });
    }
    try {
      const events = await fetchActivity(40, { full: true });
      fullCache = { at: Date.now(), events };
      return cachedPublicJson({ events, cached: false });
    } catch (error) {
      if (fullCache) {
        return cachedPublicJson({ events: fullCache.events, cached: true, stale: true });
      }
      return publicError(error, "Could not load full activity history.");
    }
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson({ events: cache.events, cached: true });
  }

  try {
    const events = await fetchActivity(40);
    cache = { at: Date.now(), events };
    return cachedPublicJson({ events, cached: false });
  } catch (error) {
    // Serve a stale cache rather than an empty feed: an empty list reads as
    // "nothing ever traded here", which is a lie when the RPC is merely down.
    if (cache) {
      return cachedPublicJson({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load activity.");
  }
}
