import { MARKET_VAULT_ADDRESS, MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import { collectionVaultAddresses } from "@/lib/market/collections";
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

const caches = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 15_000;
/** Serve KV without waiting on RPC when younger than this. */
const KV_FAST_MS = 25_000;

function parseVaultParam(req: Request): string | null {
  const raw = new URL(req.url).searchParams.get("vault");
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  const lc = raw.toLowerCase();
  const hit = MARKET_VAULT_ADDRESSES.find((a) => a.toLowerCase() === lc);
  if (hit) return hit;
  // Per-collection vaults (collection entries ship with releases).
  return collectionVaultAddresses().includes(lc) ? raw : null;
}

/**
 * Public read-only vault dashboard data.
 * Optional `?vault=0x…` (must be a configured vault) — Instant Swap V1/V2 switch.
 * Layers: isolate memory → database (fast path) → chain → stale cache fallback.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-stats", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const vault = parseVaultParam(req) ?? MARKET_VAULT_ADDRESS;
  if (!vault) {
    return publicJson({ error: "NO_VAULT", message: "No vault configured." }, 404);
  }
  const cacheKey = vault.toLowerCase();
  const cache = caches.get(cacheKey) ?? null;

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return cachedPublicJson(cache.data, "live", {
      headers: { "X-Vault-Stats": "memory", "X-Vault": cacheKey },
    });
  }

  // Fast path: durable cache warm enough that we skip a cold RPC round-trip.
  // Don't short-circuit if APR was never computed (null) — re-fetch so the
  // dashboard can fill APR after a code fix / partial cache write.
  const kvHit = await readVaultStatsCache(vault);
  if (kvHit && Date.now() - kvHit.at < KV_FAST_MS && kvHit.stats.aprPct != null) {
    caches.set(cacheKey, { at: Date.now(), data: kvHit.stats });
    return cachedPublicJson(kvHit.stats, "live", {
      headers: { "X-Vault-Stats": "kv-fresh", "X-Vault": cacheKey },
    });
  }

  try {
    const stats = await getVaultStats(vault);
    if (!stats) {
      return publicJson({ error: "NO_VAULT", message: "No vault configured." }, 404);
    }
    caches.set(cacheKey, { at: Date.now(), data: stats });
    void writeVaultStatsCache(stats, vault);
    return cachedPublicJson(stats, "live", {
      headers: { "X-Vault-Stats": "fresh", "X-Vault": cacheKey },
    });
  } catch (error) {
    if (kvHit && isFreshEnough(kvHit)) {
      caches.set(cacheKey, { at: Date.now(), data: kvHit.stats });
      return cachedPublicJson(kvHit.stats, "live", {
        headers: { "X-Vault-Stats": "stale-cache", "X-Vault": cacheKey },
      });
    }
    if (cache?.data) {
      return cachedPublicJson(cache.data, "live", {
        headers: { "X-Vault-Stats": "memory-cache", "X-Vault": cacheKey },
      });
    }
    const detail = error instanceof Error ? error.message : "Could not read vault stats right now.";
    return publicError(error, detail);
  }
}
