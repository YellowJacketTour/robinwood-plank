import { getVaultStats } from "@/lib/market/vault-stats";
import {
  isFreshEnough,
  readVaultStatsCache,
  writeVaultStatsCache,
} from "@/lib/market/vault-stats-cache";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

let cache: { at: number; data: unknown } | null = null;
const CACHE_MS = 15_000;
/** Serve KV without waiting on RPC when younger than this. */
const KV_FAST_MS = 25_000;

/**
 * Public read-only vault dashboard data.
 * Layers: isolate memory → Upstash (fast path) → chain → stale KV fallback.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-stats", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson(cache.data, "live", { headers: { "X-Vault-Stats": "memory" } });
  }

  // Fast path: durable cache warm enough that we skip a cold RPC round-trip.
  // Don't short-circuit if APR was never computed (null) — re-fetch so the
  // dashboard can fill APR after a code fix / partial cache write.
  const kvHit = await readVaultStatsCache();
  if (
    kvHit &&
    Date.now() - kvHit.at < KV_FAST_MS &&
    kvHit.stats.aprPct != null
  ) {
    cache = { at: Date.now(), data: kvHit.stats };
    return cachedPublicJson(kvHit.stats, "live", { headers: { "X-Vault-Stats": "kv-fresh" } });
  }

  try {
    const stats = await getVaultStats();
    if (!stats) {
      return publicJson({ error: "NO_VAULT", message: "No vault configured." }, 404);
    }
    cache = { at: Date.now(), data: stats };
    void writeVaultStatsCache(stats);
    return cachedPublicJson(stats, "live", { headers: { "X-Vault-Stats": "fresh" } });
  } catch (error) {
    if (kvHit && isFreshEnough(kvHit)) {
      cache = { at: Date.now(), data: kvHit.stats };
      return cachedPublicJson(kvHit.stats, "live", { headers: { "X-Vault-Stats": "stale-cache" } });
    }
    if (cache?.data) {
      return cachedPublicJson(cache.data, "live", { headers: { "X-Vault-Stats": "memory-cache" } });
    }
    const detail = error instanceof Error ? error.message : "Could not read vault stats right now.";
    return publicError(error, detail);
  }
}
