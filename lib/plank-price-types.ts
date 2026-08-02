/**
 * Shared, client-safe types for $PLANK/WETH price history. Kept separate from
 * lib/plank-price.ts because that module pulls in the durable KV adapter
 * (Redis client, Postgres) which must never end up in a client bundle.
 */

export type PriceRange = "24H" | "7D" | "ALL";
export const PRICE_RANGES: PriceRange[] = ["24H", "7D", "ALL"];

export type PlankCandle = {
  /** Unix seconds, start of the bucket. */
  time: number;
  openUsd: number;
  highUsd: number;
  lowUsd: number;
  closeUsd: number;
  openEth: number;
  highEth: number;
  lowEth: number;
  closeEth: number;
  volumeUsd: number;
};

export type PlankPriceHistory = {
  candles: PlankCandle[];
  poolAddress: string;
  network: string;
  fetchedAt: number;
  stale?: boolean;
};

/**
 * Pool-level market stats from GeckoTerminal's pool endpoint (not the OHLCV
 * endpoint) — volume, liquidity, and buy/sell counts alongside the candles.
 * Every field is either a real API value or `null` when GeckoTerminal itself
 * returned null/missing; nothing here is derived or estimated client-side.
 */
export type PlankPoolStats = {
  priceUsd: number;
  priceEth: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** Pool reserves in USD — used as the "Liquidity" figure. */
  liquidityUsd: number | null;
  priceChangePct: {
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };
  volumeUsd24h: number | null;
  transactions24h: {
    buys: number;
    sells: number;
    buyers: number;
    sellers: number;
  } | null;
  /** ISO timestamp the pool was created — used to explain a short "ALL" range. */
  poolCreatedAt: string | null;
  fetchedAt: number;
  stale?: boolean;
};

/**
 * A single $PLANK trading venue, from DexScreener's token endpoint (which,
 * unlike GeckoTerminal's single-pool endpoints, lists every pool for a token
 * in one call). $PLANK trades across multiple real pools with very different
 * depth — this is what powers the "all pools" panel and the honest aggregate
 * stats, since any single pool's liquidity understates the token's real total.
 */
export type PlankPool = {
  dexId: string;
  /** e.g. "v2", "v3", "v4" — DexScreener's protocol-version label. */
  version: string | null;
  pairAddress: string;
  quoteSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volumeUsd24h: number | null;
  priceChangePct24h: number | null;
  /**
   * DexScreener's own fully-diluted valuation for this pair (its price x
   * $PLANK's total supply). Carried purely so /trade can cross-check our
   * independently-computed FDV against a third party — it is never the
   * number the UI publishes as the headline.
   *
   * DexScreener also returns a `marketCap` field, deliberately NOT mapped
   * here: for $PLANK it is byte-identical to `fdv` on every pair, because
   * DexScreener has no verified circulating supply either and falls back to
   * total supply. Importing it would put a "market cap" label on an FDV
   * number, which is the exact error lib/plank-valuation.ts exists to
   * prevent.
   */
  fdvUsd: number | null;
  txns24h: { buys: number; sells: number } | null;
  /** ISO timestamp; null if DexScreener didn't return a creation time. */
  pairCreatedAt: string | null;
  /** External DexScreener page for this exact pool. */
  url: string;
};

export type PlankPoolsSummary = {
  pools: PlankPool[];
  totalLiquidityUsd: number | null;
  totalVolumeUsd24h: number | null;
  fetchedAt: number;
  stale?: boolean;
};

/**
 * lightweight-charts requires strictly increasing series timestamps.
 * GeckoTerminal's live OHLCV feed has been observed repeating an identical
 * row for the same time bucket back-to-back — real upstream data, not
 * something generated here — so every candle array is deduped through this
 * exact function before it ever reaches the server cache OR a chart series.
 * Collapses consecutive same-time entries, keeping the later (more-settled)
 * one. Input must already be sorted ascending by time.
 */
export function dedupeSortedCandles(candles: PlankCandle[]): PlankCandle[] {
  const deduped: PlankCandle[] = [];
  for (const candle of candles) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === candle.time) {
      deduped[deduped.length - 1] = candle;
    } else {
      deduped.push(candle);
    }
  }
  return deduped;
}
