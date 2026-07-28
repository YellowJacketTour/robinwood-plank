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
  const res = await fetch("/api/market/activity");
  if (!res.ok) return null;
  const data = (await res.json()) as {
    events?: Array<{ kind: string; priceWei: string | null }>;
  };
  const priced = (data.events ?? []).filter(
    (e): e is { kind: string; priceWei: string } => e.kind === "sale" && e.priceWei != null
  );
  if (priced.length === 0) return null;
  const total = priced.reduce((sum, e) => sum + BigInt(e.priceWei), BigInt(0));
  return total / BigInt(priced.length);
}
