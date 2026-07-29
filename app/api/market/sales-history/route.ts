import { publicError, publicJson, rateLimit } from "@/lib/security";
import { readSalesCatalog } from "@/lib/market/sales-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Full royalty-aware sale list for Activity price history chart.
 * Ordered oldest → newest for sparklines.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-sales-history", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const catalog = await readSalesCatalog();
    const sales = [...(catalog?.sales ?? [])].sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      if (ta && tb) return ta - tb;
      return (a.blockNumber || 0) - (b.blockNumber || 0);
    });
    return publicJson({
      sales: sales.map((s) => ({
        tokenId: s.tokenId,
        priceWei: s.priceWei,
        timestamp: s.timestamp,
        txHash: s.txHash,
        platform: s.platform,
        royaltyWei: s.royaltyWei,
      })),
      count: sales.length,
    });
  } catch (err) {
    return publicError(err, "Could not load sales history.");
  }
}
