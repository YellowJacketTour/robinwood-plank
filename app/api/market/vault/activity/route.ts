import { getVaultActivity } from "@/lib/market/vault-activity";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cache: { at: number; events: unknown[] } | null = null;
const CACHE_MS = 30_000;

/**
 * Real vault trade history (buy/sell/deposit/redeem), replayed straight off
 * chain logs (lib/market/vault-activity.ts) — the dextools-style ticker for
 * Instant Swap, and the piece the NFT-collection-Transfer-based
 * /api/market/activity has no visibility into.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-activity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return publicJson({ events: cache.events, cached: true });
  }

  try {
    const events = await getVaultActivity(40);
    cache = { at: Date.now(), events };
    return publicJson({ events, cached: false });
  } catch (error) {
    if (cache) {
      return publicJson({ events: cache.events, cached: true, stale: true });
    }
    return publicError(error, "Could not load vault activity.");
  }
}
