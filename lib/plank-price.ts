/**
 * $PLANK/WETH price history, sourced from the live Uniswap v2 pool via
 * GeckoTerminal's onchain OHLCV API.
 *
 * This is a strictly different concern from the Marketplank NFT vault: it
 * prices the ERC-20 $PLANK token against ETH on the real DEX pair, not vault
 * shares or NFT sales. Never merge this with lib/market/* vault/NFT pricing.
 *
 * $PLANK trades across five pools (see lib/plank-pools.ts / DexScreener for
 * the full list and aggregate stats). This module intentionally tracks the
 * single DEEPEST pool — Uniswap v2, ~$71K liquidity vs. ~$10.6K on the v3
 * pool this used to point at — as the more honest single price reference,
 * not because v2 is the "main" venue in any other sense. The UI must always
 * say which pool the chart represents; never let it imply "the" $PLANK price
 * when it's one venue among several.
 *
 * GeckoTerminal network id for Robinhood Chain is "robinhood"; the pool below
 * was confirmed live via `GET /networks/robinhood/pools/{pool}` returning real
 * base_token_price_usd / base_token_price_native_currency for $PLANK against
 * WETH. The free tier needs no API key and is rate-limited (~30 req/min/IP),
 * so results are cached server-side well past that budget — see
 * RANGE_CONFIG's cacheTtlSec and the durable "last good" fallback below.
 */

import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import {
  dedupeSortedCandles,
  type PlankCandle,
  type PlankPoolStats,
  type PlankPriceHistory,
  type PriceRange,
} from "@/lib/plank-price-types";

export type {
  PlankCandle,
  PlankPoolStats,
  PlankPriceHistory,
  PriceRange,
} from "@/lib/plank-price-types";
export { PRICE_RANGES } from "@/lib/plank-price-types";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK_ID = "robinhood";
/**
 * PLANK / WETH Uniswap v2 pool — the deepest of $PLANK's five real pools
 * (~$71K liquidity, live since 2026-07-20). Confirmed live via GeckoTerminal,
 * not the NFT vault. See the module doc comment above for why v2 over v3.
 */
const POOL_ADDRESS = "0x01b1BEf6fBA02c846eA5c4Ff59193988B5f86F73";

type Timeframe = "day" | "hour" | "minute";
type RangeConfig = {
  timeframe: Timeframe;
  aggregate: number;
  limit: number;
  /** How long a fresh fetch stays valid before we hit GeckoTerminal again. */
  cacheTtlSec: number;
};

const RANGE_CONFIG: Record<PriceRange, RangeConfig> = {
  "24H": { timeframe: "hour", aggregate: 1, limit: 24, cacheTtlSec: 5 * 60 },
  "7D": { timeframe: "hour", aggregate: 4, limit: 42, cacheTtlSec: 15 * 60 },
  // Pool is young; "day" buckets return whatever real history exists so far
  // and simply grow as more days trade — never padded or backfilled.
  ALL: { timeframe: "day", aggregate: 1, limit: 1000, cacheTtlSec: 30 * 60 },
};

/** How long a stale "last good" snapshot may still be served if GeckoTerminal
 * is down or rate-limiting us — an honest stale chart beats a blank one. */
const LAST_GOOD_TTL_SEC = 7 * 24 * 60 * 60;

type OhlcvRow = [number, number, number, number, number, number];

/**
 * GeckoTerminal's free tier is rate-limited (~30 req/min/IP), and this dev
 * environment is currently shared by several agents hitting the same pool
 * endpoints concurrently — a transient 429/5xx here is expected, not
 * necessarily a real outage. One short retry absorbs that without falling
 * straight through to the last-good snapshot (or a hard error) on every
 * momentary burst.
 */
async function fetchJsonWithRetry(url: string): Promise<unknown> {
  const attempt = async (): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    try {
      return await fetch(url, {
        headers: {
          Accept: "application/json;version=20230302",
          "User-Agent": "plank.love-price-chart/1.0",
        },
        signal: ac.signal,
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attempt();
  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    res = await attempt();
  }
  if (!res.ok) {
    throw new Error(`GeckoTerminal HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchOhlcvRaw(
  config: RangeConfig,
  currency: "usd" | "token"
): Promise<OhlcvRow[]> {
  const url =
    `${GECKOTERMINAL_BASE}/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/ohlcv/${config.timeframe}` +
    `?aggregate=${config.aggregate}&limit=${config.limit}&currency=${currency}`;
  const json = (await fetchJsonWithRetry(url)) as {
    data?: { attributes?: { ohlcv_list?: OhlcvRow[] } };
  };
  return json?.data?.attributes?.ohlcv_list ?? [];
}

async function fetchFresh(range: PriceRange): Promise<PlankPriceHistory> {
  const config = RANGE_CONFIG[range];
  // Two currency views of the SAME real candles (never derived/approximated
  // from a single series) — GeckoTerminal computes both from the same swaps.
  const [usdRows, ethRows] = await Promise.all([
    fetchOhlcvRaw(config, "usd"),
    fetchOhlcvRaw(config, "token"),
  ]);
  const ethByTime = new Map(ethRows.map((row) => [row[0], row]));

  const candles: PlankCandle[] = usdRows
    .map((row): PlankCandle | null => {
      const [time, openUsd, highUsd, lowUsd, closeUsd, volumeUsd] = row;
      const ethRow = ethByTime.get(time);
      if (!ethRow) return null;
      const [, openEth, highEth, lowEth, closeEth] = ethRow;
      return {
        time,
        openUsd,
        highUsd,
        lowUsd,
        closeUsd,
        openEth,
        highEth,
        lowEth,
        closeEth,
        volumeUsd,
      };
    })
    .filter((c): c is PlankCandle => c != null)
    .sort((a, b) => a.time - b.time);

  // GeckoTerminal's OHLCV feed occasionally repeats an identical row for the
  // same bucket back-to-back (observed on the live "hour" timeframe) — real
  // upstream data, not something we generate, but lightweight-charts requires
  // strictly increasing timestamps. dedupeSortedCandles is the single source
  // of truth for this invariant — see its doc comment in plank-price-types.
  return {
    candles: dedupeSortedCandles(candles),
    poolAddress: POOL_ADDRESS,
    network: NETWORK_ID,
    fetchedAt: Date.now(),
  };
}

const memCache = new Map<string, { at: number; data: PlankPriceHistory }>();
const memLastGood = new Map<string, PlankPriceHistory>();

// Keys are scoped by POOL_ADDRESS, not just range — if which pool this
// module tracks ever changes again, old entries become simply orphaned
// (and expire on their own TTL) instead of a stale different-pool snapshot
// silently serving as this pool's "last good" fallback.
function cacheKey(range: PriceRange): string {
  return `plank:price-history:v1:${POOL_ADDRESS}:${range}`;
}
function lastGoodKey(range: PriceRange): string {
  return `plank:price-history:last-good:v1:${POOL_ADDRESS}:${range}`;
}

/** How long a fresh pool-stats fetch stays valid before refetching. Stats
 * change faster than candles but a shared 60s cache across every viewer
 * stays comfortably inside GeckoTerminal's free-tier rate budget. */
const STATS_CACHE_TTL_SEC = 60;
const STATS_CACHE_KEY = `plank:pool-stats:v1:${POOL_ADDRESS}`;
const STATS_LAST_GOOD_KEY = `plank:pool-stats:last-good:v1:${POOL_ADDRESS}`;

type PoolAttributes = {
  base_token_price_usd?: string;
  base_token_price_native_currency?: string;
  fdv_usd?: string | null;
  market_cap_usd?: string | null;
  reserve_in_usd?: string | null;
  pool_created_at?: string | null;
  price_change_percentage?: {
    h1?: string | null;
    h6?: string | null;
    h24?: string | null;
  };
  volume_usd?: { h24?: string | null };
  transactions?: {
    h24?: {
      buys?: number | null;
      sells?: number | null;
      buyers?: number | null;
      sellers?: number | null;
    };
  };
};

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchPoolStatsFresh(): Promise<PlankPoolStats> {
  const url = `${GECKOTERMINAL_BASE}/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}`;
  const json = (await fetchJsonWithRetry(url)) as { data?: { attributes?: PoolAttributes } };
  const attrs = json?.data?.attributes ?? {};

  const priceUsd = toNumberOrNull(attrs.base_token_price_usd);
  const priceEth = toNumberOrNull(attrs.base_token_price_native_currency);
  if (priceUsd == null || priceEth == null) {
    throw new Error("GeckoTerminal pool stats missing base token price");
  }

  const h24 = attrs.transactions?.h24;

  return {
    priceUsd,
    priceEth,
    fdvUsd: toNumberOrNull(attrs.fdv_usd),
    marketCapUsd: toNumberOrNull(attrs.market_cap_usd),
    liquidityUsd: toNumberOrNull(attrs.reserve_in_usd),
    priceChangePct: {
      h1: toNumberOrNull(attrs.price_change_percentage?.h1),
      h6: toNumberOrNull(attrs.price_change_percentage?.h6),
      h24: toNumberOrNull(attrs.price_change_percentage?.h24),
    },
    volumeUsd24h: toNumberOrNull(attrs.volume_usd?.h24),
    transactions24h: h24
      ? {
          buys: Number(h24.buys) || 0,
          sells: Number(h24.sells) || 0,
          buyers: Number(h24.buyers) || 0,
          sellers: Number(h24.sellers) || 0,
        }
      : null,
    poolCreatedAt: typeof attrs.pool_created_at === "string" ? attrs.pool_created_at : null,
    fetchedAt: Date.now(),
  };
}

/**
 * Server-side entry point for the pool stat strip (price/FDV/liquidity/volume/
 * buys-sells). Same cache-then-refetch-then-last-good discipline as
 * getPlankPriceHistory, kept as an independent cache key since stats refresh
 * on a different cadence than candles.
 */
export async function getPlankPoolStats(): Promise<PlankPoolStats> {
  const useKv = hasDurableKv();

  if (useKv) {
    try {
      const cached = await kv.get<PlankPoolStats>(STATS_CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_SEC * 1000) {
        return cached;
      }
    } catch {
      // fall through to a live fetch
    }
  } else {
    const hit = memCache.get(STATS_CACHE_KEY) as { at: number; data: PlankPoolStats } | undefined;
    if (hit && Date.now() - hit.at < STATS_CACHE_TTL_SEC * 1000) {
      return hit.data;
    }
  }

  try {
    const fresh = await fetchPoolStatsFresh();
    if (useKv) {
      await kv.set(STATS_CACHE_KEY, fresh, { ex: STATS_CACHE_TTL_SEC * 2 }).catch(() => {});
      await kv.set(STATS_LAST_GOOD_KEY, fresh, { ex: LAST_GOOD_TTL_SEC }).catch(() => {});
    } else {
      memStatsCache.set(STATS_CACHE_KEY, { at: Date.now(), data: fresh });
      memStatsLastGood.set(STATS_CACHE_KEY, fresh);
    }
    return fresh;
  } catch (err) {
    if (useKv) {
      try {
        const lastGood = await kv.get<PlankPoolStats>(STATS_LAST_GOOD_KEY);
        if (lastGood) return { ...lastGood, stale: true };
      } catch {
        // no durable fallback available either
      }
    } else {
      const lastGood = memStatsLastGood.get(STATS_CACHE_KEY);
      if (lastGood) return { ...lastGood, stale: true };
    }
    throw err;
  }
}

const memStatsCache = new Map<string, { at: number; data: PlankPoolStats }>();
const memStatsLastGood = new Map<string, PlankPoolStats>();

/**
 * Server-side entry point: returns cached data when fresh, refetches from
 * GeckoTerminal when stale, and falls back to the last known-good snapshot
 * (marked `stale: true`) rather than throwing when the upstream call fails.
 * Never fabricates candles that were never returned by a real fetch.
 */
export async function getPlankPriceHistory(
  range: PriceRange
): Promise<PlankPriceHistory> {
  const config = RANGE_CONFIG[range];
  const key = cacheKey(range);
  const useKv = hasDurableKv();

  if (useKv) {
    try {
      const cached = await kv.get<PlankPriceHistory>(key);
      if (cached && Date.now() - cached.fetchedAt < config.cacheTtlSec * 1000) {
        return cached;
      }
    } catch {
      // fall through to a live fetch
    }
  } else {
    const hit = memCache.get(key);
    if (hit && Date.now() - hit.at < config.cacheTtlSec * 1000) {
      return hit.data;
    }
  }

  try {
    const fresh = await fetchFresh(range);
    if (fresh.candles.length > 0) {
      if (useKv) {
        await kv.set(key, fresh, { ex: config.cacheTtlSec * 2 }).catch(() => {});
        await kv
          .set(lastGoodKey(range), fresh, { ex: LAST_GOOD_TTL_SEC })
          .catch(() => {});
      } else {
        memCache.set(key, { at: Date.now(), data: fresh });
        memLastGood.set(key, fresh);
      }
    }
    return fresh;
  } catch (err) {
    if (useKv) {
      try {
        const lastGood = await kv.get<PlankPriceHistory>(lastGoodKey(range));
        if (lastGood) return { ...lastGood, stale: true };
      } catch {
        // no durable fallback available either
      }
    } else {
      const lastGood = memLastGood.get(key);
      if (lastGood) return { ...lastGood, stale: true };
    }
    throw err;
  }
}
