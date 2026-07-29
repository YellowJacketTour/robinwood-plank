/**
 * Collection-wide average sale price, in wei — the same computation
 * ActivityStats.tsx uses for its own "Avg price" stat, extracted so
 * TreasuryBootstrap can use the identical number for seed-ratio math
 * instead of a second, potentially-drifted calculation.
 *
 * Floor price isn't used here on purpose: this collection frequently has
 * zero active listings (floor reads as "—"), so it's not a reliable seed
 * anchor. Average of actually-settled sales is the best real signal
 * available, same reasoning as the original seed-pricing recommendation.
 */
export async function getAvgSalePriceWei(): Promise<bigint | null> {
  const fromEvents = async (url: string): Promise<bigint | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        events?: Array<{ kind?: string; priceWei?: string | null; price?: string | null }>;
        sales?: Array<{ priceWei?: string | null }>;
      };
      const priced: bigint[] = [];
      for (const e of data.events ?? []) {
        if (e.kind && e.kind !== "sale") continue;
        const w = e.priceWei ?? e.price;
        if (w != null && w !== "" && w !== "0") {
          try {
            priced.push(BigInt(w));
          } catch {
            /* skip */
          }
        }
      }
      for (const e of data.sales ?? []) {
        if (e.priceWei) {
          try {
            priced.push(BigInt(e.priceWei));
          } catch {
            /* skip */
          }
        }
      }
      if (priced.length === 0) return null;
      const total = priced.reduce((a, b) => a + b, BigInt(0));
      return total / BigInt(priced.length);
    } catch {
      return null;
    }
  };

  return (
    (await fromEvents("/api/market/activity")) ??
    (await fromEvents("/api/market/sales-history")) ??
    null
  );
}
