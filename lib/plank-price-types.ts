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
