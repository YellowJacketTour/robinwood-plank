/**
 * $PLANK/WETH price history, sourced from the live Uniswap v3 pool via
 * GeckoTerminal's onchain OHLCV API.
 *
 * This is a strictly different concern from the Marketplank NFT vault: it
 * prices the ERC-20 $PLANK token against ETH on the real DEX pair, not vault
 * shares or NFT sales. Never merge this with lib/market/* vault/NFT pricing.
 *
 * GeckoTerminal network id for Robinhood Chain is "robinhood"; the pool below
 * was confirmed live via `GET /networks/robinhood/pools/{pool}` returning real
 * base_token_price_usd / base_token_price_native_currency for $PLANK against
 * WETH. The free tier needs no API key and is rate-limited (~30 req/min/IP),
 * so results are cached server-side well past that budget — see
 * RANGE_CONFIG's cacheTtlSec and the durable "last good" fallback below.
 */

import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import type { PlankCandle, PlankPriceHistory, PriceRange } from "@/lib/plank-price-types";

export type { PlankCandle, PlankPriceHistory, PriceRange } from "@/lib/plank-price-types";
export { PRICE_RANGES } from "@/lib/plank-price-types";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const NETWORK_ID = "robinhood";
/** PLANK / WETH 1% Uniswap v3 pool — confirmed live, not the NFT vault. */
const POOL_ADDRESS = "0x3CE05Efe2e7C9c136f12a1Be695f75F807B6c69E";

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

async function fetchOhlcvRaw(
  config: RangeConfig,
  currency: "usd" | "token"
): Promise<OhlcvRow[]> {
  const url =
    `${GECKOTERMINAL_BASE}/networks/${NETWORK_ID}/pools/${POOL_ADDRESS}/ohlcv/${config.timeframe}` +
    `?aggregate=${config.aggregate}&limit=${config.limit}&currency=${currency}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json;version=20230302",
        "User-Agent": "plank.love-price-chart/1.0",
      },
      signal: ac.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`GeckoTerminal OHLCV HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: OhlcvRow[] } };
    };
    return json?.data?.attributes?.ohlcv_list ?? [];
  } finally {
    clearTimeout(timer);
  }
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

  return {
    candles,
    poolAddress: POOL_ADDRESS,
    network: NETWORK_ID,
    fetchedAt: Date.now(),
  };
}

const memCache = new Map<string, { at: number; data: PlankPriceHistory }>();
const memLastGood = new Map<string, PlankPriceHistory>();

function cacheKey(range: PriceRange): string {
  return `plank:price-history:v1:${range}`;
}
function lastGoodKey(range: PriceRange): string {
  return `plank:price-history:last-good:v1:${range}`;
}

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
