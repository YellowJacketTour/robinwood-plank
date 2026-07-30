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
