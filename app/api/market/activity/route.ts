import { fetchActivity } from "@/lib/market/activity";
import { publicError, publicJson, rateLimit } from "@/lib/security";

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

let cache: { at: number; events: unknown[] } | null = null;

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return publicJson({ events: cache.events, cached: true });
  }

  try {
    const events = await fetchActivity(40);
    cache = { at: Date.now(), events };
    return publicJson({ events, cached: false });
  } catch (error) {
    // Serve a stale cache rather than an empty feed: an empty list reads as
    // "nothing ever traded here", which is a lie when the RPC is merely down.
    if (cache) {
      return publicJson({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load activity.");
  }
}
