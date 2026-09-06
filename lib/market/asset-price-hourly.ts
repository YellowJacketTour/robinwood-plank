/**
 * USD-at-time-of-sale, hourly (AUDIT lens 6 #8; RESEARCH lens R1 (5):
 * Allium/Dune price `nft.trades` at the HOURLY exchange rate, never daily
 * and never "today's spot re-applied to history").
 *
 * Reads plank_asset_price_hourly (migration 100) for the sale's own hour;
 * when no close is stored for that hour it falls back to the current spot
 * quote from lib/multi-asset-price.ts and labels the row 'spot-fallback'
 * so a reader can tell a real historical close from a best-effort one.
 * Stablecoins are 1.0 by definition (source 'stablecoin').
 *
 * `asset` is the plain symbol lib/multi-asset-price.ts keys by (ETH, SOL,
 * BTC, POL, BNB, AVAX, USDC, USDT); wrapped forms (WETH, WSOL, ...) are
 * normalized first.
 */
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { getMultiAssetUsdPrices, normalizeAssetSymbol } from "@/lib/multi-asset-price";
import { chainManifest } from "@/lib/market/multichain/chains/manifest";
import { STABLECOINS_BY_CHAIN } from "@/lib/market/multichain/trading/stablecoins";

export type HourlyUsd = { usd: number; source: string; hour: string };

const STABLE_SYMBOLS = new Set(["USDC", "USDT"]);

export function hourFloor(timestamp: Date | number | string): Date {
  const ms = timestamp instanceof Date ? timestamp.getTime() : typeof timestamp === "number" ? (timestamp < 1e12 ? timestamp * 1000 : timestamp) : Date.parse(timestamp);
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * USD price of one whole unit of `asset` at the hour containing
 * `timestamp`. Null when neither a stored close nor a spot quote exists
 * (never fabricated).
 */
export async function usdAtHour(asset: string | null | undefined, timestamp: Date | number | string | null | undefined): Promise<HourlyUsd | null> {
  const symbol = normalizeAssetSymbol(asset);
  if (!symbol) return null;
  const hour = hourFloor(timestamp ?? Date.now());
  if (STABLE_SYMBOLS.has(symbol)) return { usd: 1, source: "stablecoin", hour: hour.toISOString() };
  if (hasPostgresConfig()) {
    try {
      const stored = await postgresQuery<{ usd: string; source: string }>(
        `SELECT usd::text AS usd, source FROM plank_asset_price_hourly WHERE asset = $1 AND hour = $2::timestamptz`,
        [symbol, hour.toISOString()]
      );
      const row = stored.rows[0];
      if (row) {
        const usd = Number(row.usd);
        if (Number.isFinite(usd) && usd > 0) return { usd, source: row.source, hour: hour.toISOString() };
      }
    } catch {
      // table missing / transient -- fall through to spot
    }
  }
  try {
    const spot = (await getMultiAssetUsdPrices())[symbol];
    if (spot && typeof spot.usd === "number" && spot.usd > 0) return { usd: spot.usd, source: "spot-fallback", hour: hour.toISOString() };
  } catch {
    // no quote available
  }
  return null;
}

/** Store one hourly close (idempotent; a later write for the same hour replaces). */
export async function recordHourlyUsd(asset: string, hour: Date | number | string, usd: number, source: string): Promise<void> {
  const symbol = normalizeAssetSymbol(asset);
  if (!symbol || !Number.isFinite(usd) || usd <= 0) return;
  await postgresQuery(
    `INSERT INTO plank_asset_price_hourly (asset, hour, usd, source) VALUES ($1, $2::timestamptz, $3, $4)
     ON CONFLICT (asset, hour) DO UPDATE SET usd = EXCLUDED.usd, source = EXCLUDED.source`,
    [symbol, hourFloor(hour).toISOString(), usd, source]
  );
}

/**
 * Resolves the pricing asset + decimals for a fill's currency: null
 * currency = the chain's native symbol (18 decimals on EVM, 9 on Solana,
 * 8 on Bitcoin); the chain's wrapped-native address = the native symbol;
 * a known stablecoin address = USDC/USDT with its REAL decimals (BNB's
 * are 18, see stablecoins.ts). Unknown ERC-20s return null -- never priced
 * as if they were ETH.
 */
export function pricingAssetForCurrency(chainSlug: string, currencyAddress: string | null | undefined): { asset: string; decimals: number } | null {
  const m = chainManifest(chainSlug);
  if (!m) return null;
  const nativeDecimals = m.kind === "solana" ? 9 : m.kind === "ordinals" ? 8 : 18;
  if (!currencyAddress) return { asset: m.nativeCurrencySymbol, decimals: nativeDecimals };
  const lower = currencyAddress.toLowerCase();
  if (m.offerCurrencyAddress && m.offerCurrencyAddress.toLowerCase() === lower) return { asset: m.nativeCurrencySymbol, decimals: 18 };
  if (m.chainId != null) {
    const stable = STABLECOINS_BY_CHAIN[m.chainId]?.find((s) => s.address.toLowerCase() === lower);
    if (stable) return { asset: stable.symbol, decimals: stable.decimals };
  }
  return null;
}

/**
 * amount_usd for an atomic amount in `currencyAddress` on `chainSlug` at
 * `timestamp` (Unix seconds, ms, ISO or Date). Returns the numeric string
 * Postgres accepts for NUMERIC plus the price source, or nulls when the
 * currency is unknown or no price exists.
 */
export async function amountUsdAtSale(
  chainSlug: string,
  currencyAddress: string | null | undefined,
  amountAtomic: string | null | undefined,
  timestamp: Date | number | string | null | undefined
): Promise<{ amountUsd: string | null; source: string | null; asset: string | null }> {
  if (!amountAtomic) return { amountUsd: null, source: null, asset: null };
  const pricing = pricingAssetForCurrency(chainSlug, currencyAddress);
  if (!pricing) return { amountUsd: null, source: null, asset: null };
  const price = await usdAtHour(pricing.asset, timestamp);
  if (!price) return { amountUsd: null, source: null, asset: pricing.asset };
  let atomic: bigint;
  try {
    atomic = BigInt(amountAtomic);
  } catch {
    return { amountUsd: null, source: null, asset: pricing.asset };
  }
  const whole = Number(atomic) / 10 ** pricing.decimals;
  if (!Number.isFinite(whole)) return { amountUsd: null, source: null, asset: pricing.asset };
  return { amountUsd: (whole * price.usd).toFixed(6), source: price.source, asset: pricing.asset };
}
