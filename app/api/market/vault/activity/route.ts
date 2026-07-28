import { NextResponse } from "next/server";
import { getVaultActivity } from "@/lib/market/vault-activity";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cache: { at: number; events: unknown[] } | null = null;
const CACHE_MS = 30_000;
// The full-lineage variant (?full=1) walks every chunk MAX_CHUNKS allows
// instead of stopping early once it has enough recent events — real extra
// RPC cost, so it gets its own longer-lived cache rather than sharing the
// 30s one above.
let fullCache: { at: number; events: unknown[] } | null = null;
const FULL_CACHE_MS = 120_000;

/** publicJson forces Cache-Control: no-store — fine for most routes, wrong
 * here: it meant every load (and the SSE stream's own separate cache never
 * helped this REST route either) re-hit this on the network even when the
 * 30s server cache above was warm, and did nothing at all on a cold
 * serverless instance. */
function cachedPublicJson(data: unknown): NextResponse {
  return NextResponse.json(data, {
    headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60" },
  });
}

/**
 * Real vault trade history (buy/sell/deposit/redeem), replayed straight off
 * chain logs (lib/market/vault-activity.ts) — the dextools-style ticker for
 * Instant Swap, and the piece the NFT-collection-Transfer-based
 * /api/market/activity has no visibility into.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const full = new URL(req.url).searchParams.get("full") === "1";

  if (full) {
    if (fullCache && Date.now() - fullCache.at < FULL_CACHE_MS) {
      return cachedPublicJson({ events: fullCache.events, cached: true });
    }
    try {
      const events = await getVaultActivity(undefined, { full: true });
      fullCache = { at: Date.now(), events };
      return cachedPublicJson({ events, cached: false });
    } catch (error) {
      if (fullCache) {
        return cachedPublicJson({ events: fullCache.events, cached: true, stale: true });
      }
      return publicError(error, "Could not load full vault activity.");
    }
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson({ events: cache.events, cached: true });
  }

  try {
    const events = await getVaultActivity(40);
    cache = { at: Date.now(), events };
    return cachedPublicJson({ events, cached: false });
  } catch (error) {
    if (cache) {
      return cachedPublicJson({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load vault activity.");
  }
}
