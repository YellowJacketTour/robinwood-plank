import { fetchActivity } from "@/lib/market/activity";
import { cachedPublicJson as publicCached } from "@/lib/http-cache";
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
const CACHE_MS = 45_000;
// full=1 (the price chart's "full lineage" mode) walks much deeper and is
// heavier per-call (see lib/market/activity.ts's FULL_LINEAGE_LIMIT
// comment) — its own longer-lived cache, separate from the default one.
const FULL_CACHE_MS = 120_000;

let cache: { at: number; events: unknown[] } | null = null;
let fullCache: { at: number; events: unknown[] } | null = null;

function cachedPublicJson(data: unknown) {
  return publicCached(data, "market");
}

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const full = new URL(req.url).searchParams.get("full") === "1";

  if (full) {
    // Never serve a cached EMPTY full-lineage payload — that froze the price
    // chart on "No settled sales" for the whole FULL_CACHE_MS window.
    if (fullCache && fullCache.events.length > 0 && Date.now() - fullCache.at < FULL_CACHE_MS) {
      return cachedPublicJson({ events: fullCache.events, cached: true });
    }
    try {
      const events = await fetchActivity(300, { full: true });
      if (events.length > 0) {
        fullCache = { at: Date.now(), events };
      }
      // Fall back to short list if full lineage came back empty
      if (events.length === 0 && cache?.events?.length) {
        return cachedPublicJson({ events: cache.events, cached: true, stale: true });
      }
      return cachedPublicJson({ events, cached: false });
    } catch (error) {
      if (fullCache?.events?.length) {
        return cachedPublicJson({ events: fullCache.events, cached: true, stale: true });
      }
      if (cache?.events?.length) {
        return cachedPublicJson({ events: cache.events, cached: true, stale: true });
      }
      return publicError(error, "Could not load full activity history.");
    }
  }

  if (cache && cache.events.length > 0 && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson({ events: cache.events, cached: true });
  }

  try {
    const events = await fetchActivity(40);
    if (events.length > 0) {
      cache = { at: Date.now(), events };
    }
    return cachedPublicJson({ events, cached: false });
  } catch (error) {
    // Serve a stale cache rather than an empty feed: an empty list reads as
    // "nothing ever traded here", which is a lie when the RPC is merely down.
    if (cache?.events?.length) {
      return cachedPublicJson({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load activity.");
  }
}
