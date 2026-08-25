export type CurrencyIdentity = {
  chainSlug: string;
  tokenAddress: string | null;
  symbol: string;
  decimals: number;
};

export type UsdQuote = {
  usdPerToken: number;
  observedAt: string;
  source: string;
};

export type CurrencyPricedOrder = {
  orderId: string;
  amountAtomic: string;
  currency: CurrencyIdentity;
  usdQuote?: UsdQuote | null;
};

export type CurrencyFloor = {
  currency: CurrencyIdentity;
  orderId: string;
  amountAtomic: string;
  amountDecimal: string;
  amountUsd: number | null;
  usdQuote: UsdQuote | null;
};

function currencyKey(currency: CurrencyIdentity): string {
  return `${currency.chainSlug}:${currency.tokenAddress?.toLowerCase() ?? "native"}:${currency.decimals}`;
}

function atomicToDecimalString(amountAtomic: string, decimals: number): string {
  const amount = BigInt(amountAtomic);
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function quoteIsFresh(quote: UsdQuote | null | undefined, nowMs: number, maxQuoteAgeMs: number): quote is UsdQuote {
  if (!quote || !Number.isFinite(quote.usdPerToken) || quote.usdPerToken <= 0 || !quote.source.trim()) return false;
  const observedAt = Date.parse(quote.observedAt);
  return Number.isFinite(observedAt) && observedAt <= nowMs && nowMs - observedAt <= maxQuoteAgeMs;
}

/**
 * Computes one executable floor per actual payment currency. A cross-currency
 * winner is only exposed when every candidate involved has a fresh,
 * attributable USD quote; raw USDC/WETH/SOL/BTC atomic values are never
 * compared to each other.
 */
export function computeCurrencyAwareFloors(
  orders: readonly CurrencyPricedOrder[],
  options: { nowMs?: number; maxQuoteAgeMs?: number } = {}
): { byCurrency: CurrencyFloor[]; canonicalUsd: CurrencyFloor | null; incomparableCurrencies: boolean } {
  const nowMs = options.nowMs ?? Date.now();
  const maxQuoteAgeMs = options.maxQuoteAgeMs ?? 5 * 60_000;
  const winners = new Map<string, CurrencyPricedOrder>();
  for (const order of orders) {
    let amount: bigint;
    try { amount = BigInt(order.amountAtomic); } catch { continue; }
    if (amount <= 0n || order.currency.decimals < 0 || order.currency.decimals > 255) continue;
    const key = currencyKey(order.currency);
    const current = winners.get(key);
    if (!current || amount < BigInt(current.amountAtomic)) winners.set(key, order);
  }

  const byCurrency = [...winners.values()].map((order): CurrencyFloor => {
    const amountDecimal = atomicToDecimalString(order.amountAtomic, order.currency.decimals);
    const quote = quoteIsFresh(order.usdQuote, nowMs, maxQuoteAgeMs) ? order.usdQuote : null;
    return {
      currency: order.currency,
      orderId: order.orderId,
      amountAtomic: order.amountAtomic,
      amountDecimal,
      amountUsd: quote ? Number(amountDecimal) * quote.usdPerToken : null,
      usdQuote: quote,
    };
  });
  const quoted = byCurrency.filter((floor): floor is CurrencyFloor & { amountUsd: number } => floor.amountUsd != null);
  const canonicalUsd = byCurrency.length > 0 && quoted.length === byCurrency.length
    ? quoted.reduce((best, floor) => floor.amountUsd < best.amountUsd ? floor : best)
    : null;
  return { byCurrency, canonicalUsd, incomparableCurrencies: byCurrency.length > 1 && canonicalUsd == null };
}
