import { publicError, publicJson, rateLimit } from "@/lib/security";
import { readSalesCatalog, statsFromCatalog } from "@/lib/market/sales-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Royalty-aware marketplace sale stats (any platform where collection
 * royalty was paid / Seaport fulfill path). Highest sale, volume, count.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-sales-stats", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const catalog = await readSalesCatalog();
    const s = statsFromCatalog(catalog);
    return publicJson({
      ...s,
      /** Human platform label for highest sale (seaport ≈ OpenSea frontends). */
      highestPlatform: s.highestPlatform,
      royaltyRequired: true,
      note:
        "Highest sale includes any marketplace fill of RobinWood where collection royalty was paid (EIP-2981).",
    });
  } catch (err) {
    return publicError(err, "Could not load sales stats.");
  }
}
