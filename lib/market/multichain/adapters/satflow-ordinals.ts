/**
 * Satflow -- a real Bitcoin Ordinals marketplace this app had zero coverage
 * of until now, flagged live 2026-08-24 with a real example (YONDER, a
 * 121-piece collection trading almost exclusively on Satflow/Gamma): the
 * UniSat/OrdinalsWallet/ord.net venues this app already covers can have a
 * genuinely empty order book for a collection while it has real, live
 * listings on Satflow specifically -- confirmed live for YONDER (UniSat
 * book: 0 listed; Satflow: floor 0.005 BTC, 9 listed, real embedded page
 * data, live-fetched and verified before writing this file).
 *
 * TWO REAL DATA PATHS, ONE INTERFACE
 * -----------------------------------
 * 1. The real, documented, key-gated API (docs.satflow.com,
 *    https://api.satflow.com/v1, header `x-api-key`) -- confirmed real via
 *    Satflow's own open-source market-maker bot
 *    (github.com/SwapLabsInc/satflow-mm), which is the actual source for
 *    the base URL/auth shape/listings endpoint used below (their own docs
 *    site never states exact paths, only capability descriptions). Full
 *    per-listing detail (inscriptionId, price, seller) once a real
 *    SATFLOW_API_KEY is configured (owner: request one via Satflow's
 *    Discord, per satflow-mm's own README).
 * 2. An interim, collection-STATS-ONLY fallback that reads the real data
 *    Satflow's own collection page embeds in its server-rendered HTML
 *    (floorPrice, listedItems, totalSupply, volume) -- confirmed live via
 *    direct curl against a real page before writing this. This is real
 *    data, not fabricated, but it is genuinely fragile (an undocumented
 *    Next.js RSC-stream serialization detail, not a stable contract) and
 *    does NOT carry individual per-listing rows (that array loads via a
 *    separate client-side call not present in the initial page payload,
 *    and was not found after real investigation). Used ONLY when no real
 *    API key is configured; steps aside automatically the moment
 *    SATFLOW_API_KEY exists, per the owner's own explicit choice.
 */
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";

const SATFLOW_API_BASE_URL = "https://api.satflow.com/v1";
const SATFLOW_SOURCE = "satflow-ordinals";

function apiKey(): string | null {
  return process.env.SATFLOW_API_KEY?.trim() || null;
}

export type SatflowListing = {
  inscriptionId: string;
  priceSats: number;
  sellerAddress: string | null;
};

/**
 * Real per-listing data via the documented API -- returns [] (never
 * throws to the caller) when no key is configured or the real call fails,
 * matching this app's "honest empty, not a fabricated one" discipline
 * everywhere else.
 */
export async function fetchSatflowListings(collectionSlug: string, limit = 50): Promise<SatflowListing[]> {
  const key = apiKey();
  if (!key) return [];
  const gate = checkSourceBudget(SATFLOW_SOURCE);
  if (!gate.allowed) return [];
  try {
    const url = new URL(`${SATFLOW_API_BASE_URL}/activity/listings`);
    url.searchParams.set("collectionSlug", collectionSlug);
    url.searchParams.set("sortBy", "price");
    url.searchParams.set("sortDirection", "asc");
    url.searchParams.set("active", "true");
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", "x-api-key": key },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      recordSourceFailure(SATFLOW_SOURCE, res.status === 429);
      return [];
    }
    recordSourceSuccess(SATFLOW_SOURCE);
    const body = (await res.json()) as {
      data?: { items?: unknown[]; listings?: unknown[] };
    };
    const items = body.data?.items ?? body.data?.listings ?? [];
    const out: SatflowListing[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const ask = item.ask as Record<string, unknown> | undefined;
      const listing = item.listing as Record<string, unknown> | undefined;
      const token = item.token as Record<string, unknown> | undefined;
      const price = Number(ask?.price ?? item.price ?? listing?.price);
      const inscriptionId = String(
        ask?.inscriptionId ?? item.inscriptionId ?? token?.inscription_id ?? token?.id ?? ""
      );
      const seller = (ask?.sellerOrdAddress ?? item.sellerOrdAddress ?? listing?.sellerAddress ?? item.sellerAddress ?? item.seller ?? item.owner ?? null) as string | null;
      if (!inscriptionId || !Number.isFinite(price) || price <= 0) continue;
      out.push({ inscriptionId, priceSats: price, sellerAddress: seller });
    }
    return out.slice(0, limit);
  } catch {
    recordSourceFailure(SATFLOW_SOURCE, false);
    return [];
  }
}

export type SatflowCollectionStats = {
  floorPriceSats: number | null;
  listedCount: number | null;
  totalSupply: number | null;
};

/**
 * Interim, key-free fallback -- see this file's header for the real,
 * verified shape of the data and its real limits. Scrapes the real
 * server-rendered collection page for the same embedded JSON fields
 * confirmed live (floorPrice/floorPriceUnit, listedItems, totalSupply).
 * Never used when a real API key is configured (see resolveCollectionStats
 * below) -- this function existing at all is a deliberate, temporary
 * bridge, not the intended long-term data path.
 */
export async function scrapeSatflowCollectionStats(collectionSlug: string): Promise<SatflowCollectionStats | null> {
  try {
    const res = await fetch(`https://www.satflow.com/ordinals/${encodeURIComponent(collectionSlug)}`, {
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; MarketplankBot/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // The page's own escaped-JSON RSC stream uses `\"key\":value` shape.
    const floorBtc = html.match(/\\"floorPrice\\":([\d.]+),\\"topBid\\":null,\\"floorPriceUnit\\":\\"btc\\"/);
    const listed = html.match(/\\"listedItems\\":(\d+)/);
    const supply = html.match(/\\"totalSupply\\":(\d+)/);
    if (!floorBtc && !listed && !supply) return null;
    return {
      floorPriceSats: floorBtc ? Math.round(Number(floorBtc[1]) * 100_000_000) : null,
      listedCount: listed ? Number(listed[1]) : null,
      totalSupply: supply ? Number(supply[1]) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The one entry point callers should use: real API when a key exists
 * (real per-listing detail elsewhere feeds richer stats too), the scrape
 * fallback only when it does not. Never mixes the two within one call.
 */
export async function resolveSatflowCollectionStats(collectionSlug: string): Promise<SatflowCollectionStats | null> {
  if (apiKey()) {
    const listings = await fetchSatflowListings(collectionSlug, 200);
    if (listings.length === 0) return null;
    const floorPriceSats = Math.min(...listings.map((l) => l.priceSats));
    return { floorPriceSats, listedCount: listings.length, totalSupply: null };
  }
  return scrapeSatflowCollectionStats(collectionSlug);
}
