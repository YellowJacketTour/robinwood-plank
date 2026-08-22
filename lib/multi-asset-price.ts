/**
 * Live USD price for the native assets this app's tracked collections are
 * actually denominated in -- ETH (every EVM foreign chain per
 * alchemy-nft.ts's own floor-price reporting, except Polygon/BSC/Avalanche
 * which report POL/BNB/AVAX respectively -- see foreign-chain-registry.ts's
 * nativeCurrencySymbol), SOL (Magic Eden's Solana floors), and BTC (UniSat's
 * Ordinals listings, sats-denominated). Generalizes lib/eth-price.ts's
 * single-asset pattern (same CoinGecko primary / Coinbase fallback, same
 * brief cache) to N assets in one shared cache, rather than several
 * near-duplicate modules.
 *
 * POL, BNB, AVAX ids verified live against CoinGecko's /simple/price and
 * Coinbase's /v2/prices/*-USD/spot 2026-08-19. Note CoinGecko has TWO
 * separate coins for Polygon's token: "matic-network" (the old, now-frozen
 * MATIC coin -- symbol "matic") and "polygon-ecosystem-token" (the real
 * live POL token post-migration -- symbol "pol"). floorPriceCurrency
 * reports "POL" (nativeCurrencySymbol for polygon-mainnet), so this module
 * uses polygon-ecosystem-token, NOT matic-network -- using the old id would
 * silently show the wrong (frozen, no-longer-tracking) token's price.
 *
 * Every OTHER currency this app might see in a floorPriceCurrency field has
 * NO USD conversion here on purpose: adding a price for a currency this
 * module doesn't actually fetch would mean silently mapping it to the
 * wrong asset's price. assetUsdPrice() returns null for anything not in
 * ASSET_IDS, and callers must treat null as "show native value only,"
 * never as zero.
 */

type PriceCache = { usd: number; fetchedAt: number; source: string };

const g = globalThis as typeof globalThis & { __plankMultiAssetPrice?: Record<string, PriceCache> };

const CACHE_MS = 12_000;

/** CoinGecko id + Coinbase pair per asset this app can show a floor in. */
const ASSET_IDS: Record<string, { coingecko: string; coinbase: string }> = {
  ETH: { coingecko: "ethereum", coinbase: "ETH-USD" },
  SOL: { coingecko: "solana", coinbase: "SOL-USD" },
  BTC: { coingecko: "bitcoin", coinbase: "BTC-USD" },
  POL: { coingecko: "polygon-ecosystem-token", coinbase: "POL-USD" },
  BNB: { coingecko: "binancecoin", coinbase: "BNB-USD" },
  AVAX: { coingecko: "avalanche-2", coinbase: "AVAX-USD" },
};

export type MultiAssetPrices = Record<string, { usd: number | null; source: string }>;

/**
 * Fetches all three in ONE CoinGecko call (its /simple/price endpoint
 * accepts comma-separated ids natively), falling back to Coinbase
 * per-asset only for whichever one CoinGecko's single call didn't return
 * -- not a full second round-trip for all three on any partial failure.
 */
export async function getMultiAssetUsdPrices(): Promise<MultiAssetPrices> {
  const now = Date.now();
  const cache = g.__plankMultiAssetPrice ?? {};
  const symbols = Object.keys(ASSET_IDS);
  const stale = symbols.filter((s) => !cache[s] || now - cache[s].fetchedAt >= CACHE_MS);

  if (stale.length > 0) {
    try {
      const ids = stale.map((s) => ASSET_IDS[s].coingecko).join(",");
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3_000);
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: ac.signal,
      }).finally(() => clearTimeout(t));
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd?: number }>;
        for (const symbol of stale) {
          const n = data[ASSET_IDS[symbol].coingecko]?.usd;
          if (typeof n === "number" && Number.isFinite(n) && n > 0) {
            cache[symbol] = { usd: n, fetchedAt: now, source: "coingecko" };
          }
        }
      }
    } catch {
      // fall through to per-asset Coinbase fallback below
    }

    for (const symbol of stale) {
      if (cache[symbol] && now - cache[symbol].fetchedAt < CACHE_MS) continue;
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2_500);
        const res = await fetch(`https://api.coinbase.com/v2/prices/${ASSET_IDS[symbol].coinbase}/spot`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: ac.signal,
        }).finally(() => clearTimeout(t));
        if (res.ok) {
          const data = (await res.json()) as { data?: { amount?: string } };
          const n = Number(data?.data?.amount);
          if (Number.isFinite(n) && n > 0) {
            cache[symbol] = { usd: n, fetchedAt: now, source: "coinbase" };
          }
        }
      } catch {
        // keep whatever's cached, even if stale -- better than nothing
      }
    }
  }

  g.__plankMultiAssetPrice = cache;
  const result: MultiAssetPrices = {};
  for (const symbol of symbols) {
    result[symbol] = cache[symbol] ? { usd: cache[symbol].usd, source: cache[symbol].source } : { usd: null, source: "unavailable" };
  }
  return result;
}

/** Normalizes a floorPriceCurrency string (which may be "WETH"/"WSOL"/"WBTC" etc.) to the plain symbol ASSET_IDS is keyed by. */
export function normalizeAssetSymbol(currency: string | null | undefined): string | null {
  if (!currency) return null;
  const raw = currency.toUpperCase().trim();
  // Polygon providers still disagree on the post-migration ticker. Treat
  // legacy MATIC/WMATIC as POL so otherwise-valid native prices receive the
  // same independently fetched USD quote as newer provider responses.
  const upper = raw === "MATIC" || raw === "WMATIC" ? "POL" : raw.replace(/^W/, "");
  return upper in ASSET_IDS ? upper : null;
}
