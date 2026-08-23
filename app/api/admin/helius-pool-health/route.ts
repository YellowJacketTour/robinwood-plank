import { getHeliusPoolHealth } from "@/lib/market/multichain/discovery/helius-key-pool";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time Helius multi-key capacity pool health -- sibling route to
 * /api/admin/opensea-pool-health and /api/admin/alchemy-pool-health, same
 * shape/contract and same reasoning for staying a separate route per
 * provider (see alchemy-pool-health/route.ts's header). No secrets: key
 * ids are `key-0`, `key-1`, ... positional labels only.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-helius-pool-health",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const health = await getHeliusPoolHealth();
    return publicJson({ fetchedAt: new Date().toISOString(), ...health });
  } catch (err) {
    return publicError(err, "Could not read the Helius key pool's health.");
  }
}
