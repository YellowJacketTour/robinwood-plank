import { getPoolHealth } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time OpenSea multi-key capacity pool health for /admin's System
 * section -- "super simple to audit" per the owner's own standard: one call
 * shows every configured key's real durable capacity usage
 * (plank_provider_windows), real in-process circuit-breaker state, and real
 * durable (cross-process/cross-restart) jail state, plus whether the whole
 * pool is currently degraded (every key jailed/exhausted, so real callers
 * would be refused right now). No secrets: key ids are `key-0`, `key-1`, ...
 * positional labels (see opensea-key-pool.ts's own header) -- the real API
 * key strings are never read back out or exposed here.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-opensea-pool-health",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const health = await getPoolHealth();
    return publicJson({ fetchedAt: new Date().toISOString(), ...health });
  } catch (err) {
    return publicError(err, "Could not read the OpenSea key pool's health.");
  }
}
