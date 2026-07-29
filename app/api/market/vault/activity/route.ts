import { getVaultActivity } from "@/lib/market/vault-activity";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cache: { at: number; events: unknown[] } | null = null;
const CACHE_MS = 20_000;
// The full-lineage variant (?full=1) walks every chunk MAX_CHUNKS allows
// instead of stopping early once it has enough recent events — real extra
// RPC cost, so it gets its own longer-lived cache rather than sharing the
// short one above.
let fullCache: { at: number; events: unknown[] } | null = null;
const FULL_CACHE_MS = 120_000;

function ok(data: unknown) {
  return cachedPublicJson(data, "market");
}

/**
 * Real vault trade history (buy/sell/deposit/redeem/add-LP/remove-LP),
 * replayed straight off chain logs (lib/market/vault-activity.ts) — the
 * dextools-style ticker for Instant Swap, and the piece the
 * NFT-collection-Transfer-based /api/market/activity has no visibility into.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const full = new URL(req.url).searchParams.get("full") === "1";

  if (full) {
    if (fullCache && fullCache.events.length > 0 && Date.now() - fullCache.at < FULL_CACHE_MS) {
      return ok({ events: fullCache.events, cached: true });
    }
    try {
      const events = await getVaultActivity(400, { full: true });
      // Never cache an empty success — that poisoned Instant Swap history.
      if (events.length > 0) fullCache = { at: Date.now(), events };
      if (events.length === 0 && cache?.events?.length) {
        return ok({ events: cache.events, cached: true, stale: true });
      }
      return ok({ events, cached: false });
    } catch (error) {
      if (fullCache?.events?.length) {
        return ok({ events: fullCache.events, cached: true, stale: true });
      }
      if (cache?.events?.length) {
        return ok({ events: cache.events, cached: true, stale: true });
      }
      return publicError(error, "Could not load full vault activity.");
    }
  }

  if (cache && cache.events.length > 0 && Date.now() - cache.at < CACHE_MS) {
    return ok({ events: cache.events, cached: true });
  }

  try {
    const events = await getVaultActivity(80);
    if (events.length > 0) cache = { at: Date.now(), events };
    // Never return empty success when we already have a warm book.
    if (events.length === 0 && cache?.events?.length) {
      return ok({ events: cache.events, cached: true, stale: true });
    }
    return ok({ events, cached: false });
  } catch (error) {
    if (cache?.events?.length) {
      return ok({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load vault activity.");
  }
}
