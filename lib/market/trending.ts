import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { readChainActivity } from "@/lib/market/chain-events";
import { getListings } from "@/lib/market/orders-store";
import { collectionFloorWei } from "@/lib/market/floors";
import { computeWashSuspicion } from "@/lib/market/wash-trade-signal";

/** Ledger events default a missing address to this sentinel (see chain-events.ts) -- it means "unknown," not a real repeated wallet, so wash-trade detection below must never treat two ZERO_ADDRESS legs as a matching pair. */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * OURS-ONLY, DELIBERATELY — do not "fix" this to match /market's floor.
 *
 * getListings() returns our own book; foreign venues (OpenSea, PulpMarket)
 * are merged in at request time by lib/market/book.ts and never enter this
 * path. That is intentional on two grounds:
 *
 *  - Every volume and velocity signal below comes from OUR settled-sales
 *    ledger. Pairing a cross-venue floor with ours-only volume produces a
 *    half-and-half metric, and this is a RANKING, where consistent inputs
 *    matter more than any single figure being maximally true.
 *  - /discover has the same shape and a stronger reason: it is a search
 *    surface with price filters whose cards are not venue-aware, so foreign
 *    rows there would put unbuyable items in front of buyers with no badge
 *    and no link-out — the exact hazard the venue predicate exists to stop.
 *
 * So /market's floor can legitimately read lower than the trending rail's.
 * They measure different things on different pages.
 */

/** The subset of a ledger sale event these signal computations actually need. from/to are kept (not dropped as before) so real wash-trade suspicion can be computed from actual addresses -- see computeWashSuspicion(). */
type TrendingSale = { priceWei: string; timestamp: string | null; txHash: string; from: string; to: string };

/**
 * "Trending Collections" ranking — signal-driven, no static/manual curation
 * list. Pulls from the permanent chain-event ledger (lib/market/chain-events.ts,
 * migration 008_chain_events.sql — the same complete, evidence-based sale
 * history Activity and Highest Sale read) and the live order book
 * (lib/market/orders-store.ts) — the same data sources Buy & Sell and
 * Activity already use, not a new one invented for this rail. This used to
 * read lib/market/sales-catalog.ts's royalty-gated, bounded-rebuild KV blob —
 * same wrongness fixed in app/api/market/sales-stats/route.ts: a real sale
 * that didn't route EIP-2981 royalty was invisible here too, meaning a
 * collection's trending score could be understated by real missing volume.
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
 *    window. NOT a unique-buyer count — this is a trade-count proxy, not a
 *    wallet-diversity signal.
 *
 * WASH-TRADE DEFENSE (added — chain-events.ts DOES carry real from/to
 * addresses per sale; an earlier version of this file's own doc comment
 * incorrectly said they were unavailable and left volumeVelocity/tradeScore
 * fully gameable by two wallets round-tripping a sale). Real per-sale
 * addresses now feed lib/market/wash-trade-signal.ts's computeWashSuspicion(),
 * which flags exact self-transfers and reciprocal same-pair round-trips
 * (see that module's own header for the cited methodology). Suspected-wash
 * volume/trades are EXCLUDED from volumeVelocity, floor derivation, and
 * tradeScore — not just discounted at the score level — because those are
 * ledger aggregates, not a single composite term; a collection is never
 * hidden for this, only scored on its real trading, with the suspicion
 * ratio surfaced on the signal for transparency.
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
  /** Fraction of 24h volume excluded as suspected wash trading (self-transfer or reciprocal-pair round-trips) — 0 when no per-address evidence flagged anything. See wash-trade-signal.ts. */
  washSuspicionRatio24h: number;
  score: number;
};

function windowSales(sales: readonly TrendingSale[], sinceMs: number, untilMs: number): TrendingSale[] {
  return sales.filter((s) => {
    if (!s.timestamp) return false;
    const t = Date.parse(s.timestamp);
    if (!Number.isFinite(t)) return false;
    return t >= sinceMs && t < untilMs;
  });
}

function sumWei(sales: readonly TrendingSale[]): bigint {
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

function minWei(sales: readonly TrendingSale[]): bigint | null {
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

/** Distinct tx hash count — a reasonable proxy for distinct trade events. */
function uniqueTrades(sales: readonly TrendingSale[]): number {
  return new Set(sales.map((s) => s.txHash)).size;
}

/** Sales with a real, resolved from/to (excludes the ZERO_ADDRESS sentinel on either side) — the only ones wash-trade pair detection can honestly evaluate. */
function withRealAddresses(sales: readonly TrendingSale[]): TrendingSale[] {
  return sales.filter(
    (s) => s.from && s.to && s.from !== ZERO_ADDRESS && s.to !== ZERO_ADDRESS
  );
}

/** Sales NOT flagged by computeWashSuspicion() over the given window — used to exclude suspected-wash volume/trades from every downstream aggregate rather than just discounting the final score. Sales with no resolved from/to (mints, unknown legs) are always kept: there is no address evidence to judge them on, so they are never penalized for a data gap. */
function cleanSales(sales: readonly TrendingSale[]): { clean: TrendingSale[]; suspicionRatio: number } {
  const evaluable = withRealAddresses(sales);
  if (!evaluable.length) return { clean: [...sales], suspicionRatio: 0 };
  const result = computeWashSuspicion(evaluable);
  if (result.suspiciousTxHashes.size === 0) return { clean: [...sales], suspicionRatio: 0 };
  return {
    clean: sales.filter((s) => !result.suspiciousTxHashes.has(s.txHash)),
    suspicionRatio: result.suspicionRatio,
  };
}

async function ledgerSalesForContract(contractAddress: string): Promise<TrendingSale[]> {
  const sales: TrendingSale[] = [];
  let offset = 0;
  for (;;) {
    const page = await readChainActivity({
      limit: 1_000,
      offset,
      kinds: ["sale"],
      source: "nft",
      contract: contractAddress,
    });
    for (const e of page.events) {
      if (e.priceWei == null) continue;
      sales.push({ priceWei: e.priceWei, timestamp: e.timestamp, txHash: e.txHash, from: e.from, to: e.to });
    }
    if (page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  return sales;
}

export async function computeTrendingSignal(
  slug: string,
  name: string,
  image: string,
  contractAddress: string
): Promise<TrendingCollectionSignal> {
  const [sales, listings] = await Promise.all([
    ledgerSalesForContract(contractAddress),
    getListings(slug),
  ]);

  const now = Date.now();
  const rawLast24h = windowSales(sales, now - DAY_MS, now);
  const rawPrior24h = windowSales(sales, now - 2 * DAY_MS, now - DAY_MS);
  const rawLast7d = windowSales(sales, now - 7 * DAY_MS, now);

  // Wash suspicion is judged per window (see wash-trade-signal.ts's own
  // note on why it's window-relative), then suspected-wash rows are
  // excluded from every aggregate below — volume, floor, and trade count
  // all read the cleaned set, not just the final score.
  const { clean: last24h, suspicionRatio: washSuspicionRatio24h } = cleanSales(rawLast24h);
  const { clean: prior24h } = cleanSales(rawPrior24h);
  const { clean: last7d } = cleanSales(rawLast7d);

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
    washSuspicionRatio24h,
    score,
  };
}

export async function getTrendingCollections(): Promise<TrendingCollectionSignal[]> {
  const signals = await Promise.all(
    MARKET_COLLECTIONS.map((c) =>
      computeTrendingSignal(c.slug, c.name, c.image, c.contractAddress)
    )
  );
  return signals.sort((a, b) => b.score - a.score);
}
