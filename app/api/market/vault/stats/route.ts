import { getVaultStats } from "@/lib/market/vault-stats";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cache: { at: number; data: unknown } | null = null;
const CACHE_MS = 20_000;

/**
 * Public read-only vault dashboard data — reserves, live rate, fee
 * schedule, USD conversion, current NFT inventory, and a trailing APR
 * estimate. Everything here is either a direct on-chain read or replayed
 * from real Deposited/Redeemed events (lib/market/vault-stats.ts) — nothing
 * is assumed or hardcoded. Cached briefly server-side since the APR replay
 * walks chain logs and shouldn't re-scan on every page view.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-stats", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return publicJson(cache.data);
  }

  try {
    const stats = await getVaultStats();
    if (!stats) {
      return publicJson({ error: "NO_VAULT", message: "No vault configured." }, 404);
    }
    cache = { at: Date.now(), data: stats };
    return publicJson(stats);
  } catch (error) {
    return publicError(error, "Could not read vault stats right now.");
  }
}
