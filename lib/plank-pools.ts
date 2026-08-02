/**
 * All $PLANK trading venues, from DexScreener's token endpoint. $PLANK trades
 * across multiple real pools (Uniswap v2/v3/v4, Sushiswap v3) with very
 * different depth — GeckoTerminal's pool-scoped endpoints (lib/plank-price.ts)
 * only ever see one pool at a time, so any single-pool "Liquidity" figure
 * understates the token's real total. This module is the token-level view:
 * every pool DexScreener lists, plus the sum across all of them.
 *
 * DexScreener's public API needs no key and has no documented OHLCV endpoint
 * (candles stay sourced from GeckoTerminal) — this is pool/stat data only.
 * Same caching discipline as lib/plank-price.ts: cache-then-refetch, and fall
 * back to the last known-good snapshot (marked stale) rather than throwing.
 */

import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import type { PlankPool, PlankPoolsSummary } from "@/lib/plank-price-types";

export type { PlankPool, PlankPoolsSummary } from "@/lib/plank-price-types";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex/tokens";
/** $PLANK ERC-20 contract on Robinhood Chain — same token this whole trade
 * surface prices, never the RobinWood NFT collection. */
const TOKEN_ADDRESS = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";

const CACHE_TTL_SEC = 60;
const LAST_GOOD_TTL_SEC = 7 * 24 * 60 * 60;
const CACHE_KEY = "plank:pools:v1";
const LAST_GOOD_KEY = "plank:pools:last-good:v1";

type DexScreenerPair = {
  dexId?: string;
  labels?: string[];
  pairAddress?: string;
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
  url?: string;
};

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * One short retry on 429/5xx before giving up — this dev environment is
 * currently shared by several agents hitting the same endpoints
 * concurrently, so a transient rate-limit response is expected, not
 * necessarily a real outage (same rationale as lib/plank-price.ts).
 */
async function fetchPairsWithRetry(url: string): Promise<DexScreenerPair[]> {
  const attempt = async (): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    try {
      return await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "plank.love-price-chart/1.0" },
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
    throw new Error(`DexScreener HTTP ${res.status}`);
  }
  const json = (await res.json()) as { pairs?: DexScreenerPair[] | null };
  return json?.pairs ?? [];
}

async function fetchPoolsFresh(): Promise<PlankPoolsSummary> {
  const rawPairs = await fetchPairsWithRetry(`${DEXSCREENER_BASE}/${TOKEN_ADDRESS}`);

  const pools: PlankPool[] = rawPairs
    .filter((p): p is DexScreenerPair & { dexId: string; pairAddress: string; url: string } =>
      Boolean(p.dexId && p.pairAddress && p.url)
    )
    .map((p) => ({
      dexId: p.dexId,
      version: p.labels?.[0] ?? null,
      pairAddress: p.pairAddress,
      quoteSymbol: p.quoteToken?.symbol ?? "?",
      priceUsd: toNumberOrNull(p.priceUsd),
      liquidityUsd: toNumberOrNull(p.liquidity?.usd),
      volumeUsd24h: toNumberOrNull(p.volume?.h24),
      priceChangePct24h: toNumberOrNull(p.priceChange?.h24),
      // DexScreener's FDV for this pair — cross-check input only. See the
      // field's doc comment in lib/plank-price-types.ts for why its sibling
      // `marketCap` field is intentionally not carried across.
      fdvUsd: toNumberOrNull(p.fdv),
      txns24h: p.txns?.h24
        ? { buys: Number(p.txns.h24.buys) || 0, sells: Number(p.txns.h24.sells) || 0 }
        : null,
      pairCreatedAt: typeof p.pairCreatedAt === "number" ? new Date(p.pairCreatedAt).toISOString() : null,
      url: p.url,
    }))
    // Deepest liquidity first — the order the panel and any "primary pool"
    // decision should read in.
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

  const liquidityValues = pools.map((p) => p.liquidityUsd).filter((v): v is number => v != null);
  const volumeValues = pools.map((p) => p.volumeUsd24h).filter((v): v is number => v != null);

  return {
    pools,
    // Only sum what real values exist; never treat a missing field as zero
    // (that would silently understate the total instead of just omitting it).
    totalLiquidityUsd: liquidityValues.length > 0 ? liquidityValues.reduce((a, b) => a + b, 0) : null,
    totalVolumeUsd24h: volumeValues.length > 0 ? volumeValues.reduce((a, b) => a + b, 0) : null,
    fetchedAt: Date.now(),
  };
}

const memCache = new Map<string, { at: number; data: PlankPoolsSummary }>();
const memLastGood = new Map<string, PlankPoolsSummary>();

/**
 * Server-side entry point for the /trade pools panel and aggregate stats.
 * Same cache-then-refetch-then-last-good discipline as getPlankPriceHistory
 * and getPlankPoolStats.
 */
export async function getPlankPools(): Promise<PlankPoolsSummary> {
  const useKv = hasDurableKv();

  if (useKv) {
    try {
      const cached = await kv.get<PlankPoolsSummary>(CACHE_KEY);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_SEC * 1000) {
        return cached;
      }
    } catch {
      // fall through to a live fetch
    }
  } else {
    const hit = memCache.get(CACHE_KEY);
    if (hit && Date.now() - hit.at < CACHE_TTL_SEC * 1000) {
      return hit.data;
    }
  }

  try {
    const fresh = await fetchPoolsFresh();
    if (fresh.pools.length > 0) {
      if (useKv) {
        await kv.set(CACHE_KEY, fresh, { ex: CACHE_TTL_SEC * 2 }).catch(() => {});
        await kv.set(LAST_GOOD_KEY, fresh, { ex: LAST_GOOD_TTL_SEC }).catch(() => {});
      } else {
        memCache.set(CACHE_KEY, { at: Date.now(), data: fresh });
        memLastGood.set(CACHE_KEY, fresh);
      }
    }
    return fresh;
  } catch (err) {
    if (useKv) {
      try {
        const lastGood = await kv.get<PlankPoolsSummary>(LAST_GOOD_KEY);
        if (lastGood) return { ...lastGood, stale: true };
      } catch {
        // no durable fallback available either
      }
    } else {
      const lastGood = memLastGood.get(CACHE_KEY);
      if (lastGood) return { ...lastGood, stale: true };
    }
    throw err;
  }
}
