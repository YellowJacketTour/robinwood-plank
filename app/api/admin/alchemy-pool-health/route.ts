import { getAlchemyPoolHealth } from "@/lib/market/multichain/discovery/alchemy-key-pool";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time Alchemy multi-key capacity pool health -- sibling route to
 * /api/admin/opensea-pool-health, identical shape/contract, extended
 * per-provider rather than merged into one endpoint: each pool's health
 * read is already a self-contained, cheap durable-state query (no shared
 * state to merge), a caller checking on just Alchemy shouldn't pay for
 * OpenSea+Helius reads too, and keeping routes 1:1 with pool modules
 * means adding a new provider's pool later never touches this file.
 * No secrets: key ids are `key-0`, `key-1`, ... positional labels only.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "admin-alchemy-pool-health",
    limit: 30,
    windowMs: 60_000,
  });
  if (limited) return limited;
  try {
    const health = await getAlchemyPoolHealth();
    return publicJson({ fetchedAt: new Date().toISOString(), ...health });
  } catch (err) {
    return publicError(err, "Could not read the Alchemy key pool's health.");
  }
}
