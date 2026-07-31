import { MARKET_VAULT_ADDRESSES } from "@/lib/constants";
import { collectionVaultAddresses } from "@/lib/market/collections";
import { getVaultHeldTokens } from "@/lib/market/vault-held";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const caches = new Map<string, { at: number; data: unknown }>();
const CACHE_MS = 20_000;

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
 * Visual token picker / fence inventory — IDs + artwork from Blockscout
 * (Cloudflare-safe), not a multi-minute Transfer-log walk.
 * Optional `?vault=0x…` selects primary or legacy (must be a configured vault).
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "vault-held", limit: 90, windowMs: 60_000 });
  if (limited) return limited;

  const vault = parseVaultParam(req);
  const cacheKey = (vault ?? "primary").toLowerCase();
  const cache = caches.get(cacheKey) ?? null;

  // Never serve a cached EMPTY inventory — that painted "nothing held" on
  // the fence while the vault still had dozens of planks (CDN/SWR poison).
  const cachedRows =
    cache?.data &&
    typeof cache.data === "object" &&
    Array.isArray((cache.data as { tokens?: unknown }).tokens)
      ? ((cache.data as { tokens: unknown[] }).tokens as unknown[])
      : null;
  if (cache && Date.now() - cache.at < CACHE_MS && cachedRows && cachedRows.length > 0) {
    return cachedPublicJson(cache.data, "live", { headers: { "X-Vault-Held": "memory" } });
  }

  try {
    const tokens = await getVaultHeldTokens(vault);
    const data = { count: tokens.length, tokens, vault: vault ?? undefined };
    // Only cache non-empty successes. Empty may be a Blockscout blip.
    if (tokens.length > 0) {
      caches.set(cacheKey, { at: Date.now(), data });
    }
    return cachedPublicJson(data, "live", {
      headers: {
        "X-Vault-Held": "fresh",
        // Inventory must not stick empty at the edge.
        "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
        "CDN-Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=30",
      },
    });
  } catch (error) {
    if (cache?.data && cachedRows && cachedRows.length > 0) {
      return cachedPublicJson(cache.data, "live", { headers: { "X-Vault-Held": "memory-stale" } });
    }
    return publicError(error, "Could not read the vault's held tokens right now.");
  }
}
