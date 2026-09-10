export type IntelSale = { timestamp?: string | null; priceAmount?: string | null; priceWei?: string | null; priceUsd?: number | null; priceSymbol?: string | null; transaction?: string | null; tokenId?: string | null };
export type IntelAsk = { currencySymbol?: string; tokenId: string; priceWei: string; maker?: string | null; traits?: Array<{ traitType: string; value: string }> };

export function evidenceCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  const safe = /^[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** API priceWei is normalized to 18 decimal places, including SOL/BTC.
 * Keep the original decimal text for inspection; doubles only position pixels. */
function decimalPrice(sale: IntelSale): string | null {
  if (sale.priceAmount && /^\d+(\.\d+)?$/.test(sale.priceAmount)) return sale.priceAmount;
  if (!sale.priceWei || !/^\d+$/.test(sale.priceWei)) return null;
  const atomic = BigInt(sale.priceWei);
  return `${atomic / 10n ** 18n}.${(atomic % 10n ** 18n).toString().padStart(18, "0")}`;
}

export function saleCurrencies(sales: IntelSale[]): string[] {
  const currencies = new Set<string>();
  for (const sale of sales) {
    if (sale.priceSymbol && decimalPrice(sale) != null) currencies.add(sale.priceSymbol.toUpperCase());
    if (sale.priceUsd != null && Number.isFinite(sale.priceUsd) && sale.priceUsd > 0) currencies.add("USD");
  }
  return [...currencies];
}

export function saleObservations<T extends IntelSale>(sales: T[], currency: string, now = Date.now(), windowMs = Infinity) {
  return sales.flatMap((sale, sourceIndex) => {
    const time = sale.timestamp ? Date.parse(sale.timestamp) : NaN;
    const exact = currency === "USD" ? sale.priceUsd?.toString() ?? null
      : sale.priceSymbol?.toUpperCase() === currency.toUpperCase() ? decimalPrice(sale) : null;
    const value = exact == null ? NaN : Number(exact);
    if (!Number.isFinite(time) || time > now || time < now - windowMs || !Number.isFinite(value) || value <= 0) return [];
    return [{ sale, sourceIndex, time, value, exact: exact! }];
  }).sort((a, b) => a.time - b.time);
}

/** Deduplicate venue copies before computing executable depth or maker share.
 * The caller supplies a single listing currency; currencies are never pooled. */
export function askEvidence(asks: IntelAsk[], scope?: { currency: string; defaultCurrency: string }) {
  const byToken = new Map<string, IntelAsk>();
  for (const ask of asks) {
    if (scope && (ask.currencySymbol ?? scope.defaultCurrency).toUpperCase() !== scope.currency.toUpperCase()) continue;
    if (!/^\d+$/.test(ask.priceWei) || BigInt(ask.priceWei) <= 0n) continue;
    const previous = byToken.get(ask.tokenId);
    if (!previous || BigInt(ask.priceWei) < BigInt(previous.priceWei)) byToken.set(ask.tokenId, ask);
  }
  const rows = [...byToken.values()].sort((a, b) => BigInt(a.priceWei) < BigInt(b.priceWei) ? -1 : BigInt(a.priceWei) > BigInt(b.priceWei) ? 1 : 0);
  const cumulativeByPrice = new Map<string, number>();
  rows.forEach((row, index) => cumulativeByPrice.set(BigInt(row.priceWei).toString(), index + 1));
  const cumulativeDepth = rows.map((row) => cumulativeByPrice.get(BigInt(row.priceWei).toString())!);
  const floor = rows.length ? BigInt(rows[0].priceWei) : null;
  const makers = new Map<string, number>();
  for (const row of rows) {
    if (!row.maker) continue;
    const maker = /^0x[\da-f]{40}$/i.test(row.maker) ? row.maker.toLowerCase() : row.maker;
    makers.set(maker, (makers.get(maker) ?? 0) + 1);
  }
  const traits = new Map<string, { traitType: string; value: string; prices: bigint[] }>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const trait of row.traits ?? []) {
      const key = JSON.stringify([trait.traitType, trait.value]);
      if (seen.has(key)) continue;
      seen.add(key);
      const group = traits.get(key) ?? { ...trait, prices: [] };
      group.prices.push(BigInt(row.priceWei));
      traits.set(key, group);
    }
  }
  return { rows, cumulativeDepth, floorWei: floor?.toString() ?? null,
    depth10: floor == null ? null : rows.filter((row) => BigInt(row.priceWei) * 100n <= floor * 110n).length,
    makers: [...makers].map(([maker, count]) => ({ maker, count, share: count / rows.length })).sort((a, b) => b.count - a.count),
    traitPremiums: [...traits.values()].map((group) => {
      // Rows were sorted by exact price, so each trait's prices are sorted too.
      const n = group.prices.length;
      const median = n % 2 ? group.prices[Math.floor(n / 2)] : (group.prices[n / 2 - 1] + group.prices[n / 2]) / 2n;
      return { traitType: group.traitType, value: group.value, listed: n, medianWei: median.toString(),
        premiumPct: floor ? Number((median - floor) * 10_000n / floor) / 100 : null };
    }).sort((a, b) => b.listed - a.listed),
  };
}
