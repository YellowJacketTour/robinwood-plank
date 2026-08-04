import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { readSalesCatalog, type SaleRecord } from "@/lib/market/sales-catalog";
import { getListings } from "@/lib/market/orders-store";
import { collectionFloorWei } from "@/lib/market/floors";

/**
 * "Trending Collections" ranking — signal-driven, no static/manual curation
 * list. Pulls from the sales catalog (lib/market/sales-catalog.ts, the
 * existing royalty-verified sale history source) and the live order book
 * (lib/market/orders-store.ts) — the same data sources Buy & Sell and
 * Activity already use, not a new one invented for this rail.
 *
 * Signals, each over rolling 24h vs 7d windows:
 *  - volumeVelocity: 24h volume as a multiple of the 7d-average daily
 *    volume. > 1 means today is trading above its recent daily pace.
 *  - floorDeltaPct: change in the lowest observed sale price between the
 *    last 24h and the preceding 24h window (a real-trade-derived floor
 *    proxy — there is no persisted historical order-book floor snapshot to
 *    diff against, so this uses actual settled sales rather than inventing
 *    one).
 *  - tradeCount24h / tradeCount7d: distinct settled-sale tx hashes in each
 *    window. NOT a unique-buyer count — SaleRecord has no `to`/buyer address
 *    field to dedupe on (see uniqueTrades() below), so this is a trade-count
 *    proxy, not a wallet-diversity signal. It is intentionally cheap for two
 *    wallets round-tripping a sale to inflate: treat this as "how much is
 *    happening," not "how many distinct people are involved."
 *
 * Collections with no sales in the 7d window are ranked last (score 0), not
 * hidden — an empty-activity collection is still real data, not an error.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type TrendingCollectionSignal = {
  slug: string;
  name: string;
  image: string;
  volume24hWei: string;
  volume7dWei: string;
  volumeVelocity: number;
  floorWei: string | null;
  floorDeltaPct: number | null;
  /** Distinct settled-sale tx hashes, NOT unique buyers — see module doc comment. */
  tradeCount24h: number;
  tradeCount7d: number;
  saleCount24h: number;
  score: number;
};

function windowSales(sales: readonly SaleRecord[], sinceMs: number, untilMs: number): SaleRecord[] {
  return sales.filter((s) => {
    if (!s.timestamp) return false;
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t)) return false;
    return t >= sinceMs && t < untilMs;
  });
}

function sumWei(sales: readonly SaleRecord[]): bigint {
  let total = BigInt(0);
  for (const s of sales) {
    try {
      const p = BigInt(s.priceWei);
      if (p > BigInt(0)) total += p;
    } catch {
      /* skip */
    }
  }
  return total;
}

function minWei(sales: readonly SaleRecord[]): bigint | null {
  let min: bigint | null = null;
  for (const s of sales) {
    try {
      const p = BigInt(s.priceWei);
      if (p <= BigInt(0)) continue;
      if (min === null || p < min) min = p;
    } catch {
      /* skip */
    }
  }
  return min;
}

/** Buyers can't be recovered from SaleRecord alone (no `to` field there);
 * approximate uniqueness by distinct tx hash, which is a reasonable proxy
 * for distinct trade events until sales-catalog records the buyer address. */
function uniqueTrades(sales: readonly SaleRecord[]): number {
  return new Set(sales.map((s) => s.txHash)).size;
}

export async function computeTrendingSignal(
  slug: string,
  name: string,
  image: string
): Promise<TrendingCollectionSignal> {
  const [catalog, listings] = await Promise.all([readSalesCatalog(), getListings(slug)]);
  const sales = catalog?.sales ?? [];

  const now = Date.now();
  const last24h = windowSales(sales, now - DAY_MS, now);
  const prior24h = windowSales(sales, now - 2 * DAY_MS, now - DAY_MS);
  const last7d = windowSales(sales, now - 7 * DAY_MS, now);

  const volume24h = sumWei(last24h);
  const volume7d = sumWei(last7d);
  const avgDaily7d = volume7d > BigInt(0) ? Number(volume7d) / 7 : 0;
  const volumeVelocity = avgDaily7d > 0 ? Number(volume24h) / avgDaily7d : last24h.length > 0 ? Infinity : 0;

  const floorNow = collectionFloorWei(listings);
  const floorLast24h = minWei(last24h);
  const floorPrior24h = minWei(prior24h);
  let floorDeltaPct: number | null = null;
  if (floorLast24h !== null && floorPrior24h !== null && floorPrior24h > BigInt(0)) {
    floorDeltaPct =
      ((Number(floorLast24h) - Number(floorPrior24h)) / Number(floorPrior24h)) * 100;
  }

  // score: weighted blend so all three signals matter — volume velocity is
  // the dominant term (raw trading heat), floor appreciation and buyer
  // breadth are secondary tie-breakers.
  const velocityScore = Number.isFinite(volumeVelocity) ? Math.min(volumeVelocity, 10) : 10;
  const floorScore = floorDeltaPct !== null ? Math.max(-1, Math.min(1, floorDeltaPct / 100)) : 0;
  // Trade-count term, not a wallet-diversity term — see uniqueTrades() and
  // the module doc comment. Cheap for a wash-trading pair to inflate; kept
  // as a minor (15%) tie-breaker specifically because it's gameable, not
  // treated as the dominant signal.
  const tradeScore = Math.min(uniqueTrades(last24h) / 10, 1);
  const score = velocityScore * 0.6 + floorScore * 0.25 + tradeScore * 0.15;

  return {
    slug,
    name,
    image,
    volume24hWei: volume24h.toString(),
    volume7dWei: volume7d.toString(),
    volumeVelocity: Number.isFinite(volumeVelocity) ? volumeVelocity : 999,
    floorWei: floorNow !== null ? floorNow.toString() : null,
    floorDeltaPct,
    tradeCount24h: uniqueTrades(last24h),
    tradeCount7d: uniqueTrades(last7d),
    saleCount24h: last24h.length,
    score,
  };
}

export async function getTrendingCollections(): Promise<TrendingCollectionSignal[]> {
  const signals = await Promise.all(
    MARKET_COLLECTIONS.map((c) => computeTrendingSignal(c.slug, c.name, c.image))
  );
  return signals.sort((a, b) => b.score - a.score);
}
