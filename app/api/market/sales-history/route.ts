import { publicError, publicJson, rateLimit } from "@/lib/security";
import { readChainActivity } from "@/lib/market/chain-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Full sale list for the Activity price history chart, oldest → newest.
 *
 * READS THE PERMANENT LEDGER. This used to read sales-catalog.ts's
 * royalty-gated, bounded-rebuild KV blob — same wrongness fixed in
 * app/api/market/sales-stats/route.ts: a real sale that didn't route
 * EIP-2981 royalty was invisible here too, meaning the price chart could
 * silently omit real data points, not just miss recent ones.
 *
 * readChainActivity() pages at up to 1,000 rows — loop until exhausted so a
 * sale count above that (not reached yet, but the whole point of this
 * ledger is "no ceiling") doesn't silently truncate the chart.
 */
const PAGE_SIZE = 1_000;

export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-sales-history", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const sales: {
      tokenId: string;
      priceWei: string | null;
      timestamp: string | null;
      txHash: string;
      platform: string | null;
    }[] = [];

    let offset = 0;
    for (;;) {
      const page = await readChainActivity({
        limit: PAGE_SIZE,
        offset,
        kinds: ["sale"],
        source: "nft",
      });
      for (const e of page.events) {
        if (e.priceWei == null) continue; // no confirmed price, not a chartable point
        sales.push({
          tokenId: e.tokenId,
          priceWei: e.priceWei,
          timestamp: e.timestamp,
          txHash: e.txHash,
          platform: e.venue?.kind ?? null,
        });
      }
      if (page.nextOffset == null) break;
      offset = page.nextOffset;
    }

    // Ledger reads newest-first; the chart wants oldest-first for a sparkline.
    sales.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return ta - tb;
    });

    return publicJson({ sales, count: sales.length, source: "ledger" });
  } catch (err) {
    return publicError(err, "Could not load sales history.");
  }
}
