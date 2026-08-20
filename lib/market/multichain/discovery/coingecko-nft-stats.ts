/**
 * Real 24h/volume/sales/floor-change for Solana and Bitcoin Ordinals
 * collections, via CoinGecko's public NFT API -- closes a real gap
 * flagged live 2026-08-20 ("what's it going to take to get you to finally
 * fix this through and through"): the only prior write path for these
 * fields anywhere in this codebase (rarity-index-runner.ts) calls
 * OpenSea's stats endpoint directly, which structurally can only ever
 * cover EVM collections with an OpenSea listing -- never Bitcoin, never
 * Solana, never Robinhood Chain's own community collections.
 *
 * REAL, LIVE-VERIFIED SOURCE, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * Confirmed live 2026-08-20 with real test calls: GET
 * https://api.coingecko.com/api/v3/nfts/{id} returns real
 * volume_24h.native_currency, one_day_sales, and
 * floor_price_24h_percentage_change.native_currency for both a real
 * Solana collection (Aurorians) and a real Bitcoin Ordinals collection
 * (Aeons). No API key required to read; a free CoinGecko Demo key
 * (COINGECKO_API_KEY, registration only, no cost) raises the rate limit
 * from 5-15 calls/min to 100 calls/min -- this module works either way,
 * just paces itself to the unauthenticated limit when no key is present.
 *
 * MATCHING: EXACT SLUG ONLY, NEVER FUZZY
 * ---------------------------------------------------------------------------
 * CoinGecko's own `id` field for an ordinals-platform entry is
 * confirmed live to exactly match this app's own UniSat-collections
 * slug convention (e.g. "bitcoin-frogs" exists verbatim in both). Only
 * an EXACT, case-insensitive string match counts as a real match; no
 * Levenshtein/fuzzy matching, which would risk silently attaching one
 * collection's real trading stats to a different, wrong collection --
 * a worse failure than staying null. A collection this can't exactly
 * match simply stays unmatched (fields stay null), never guessed.
 */
import { hasMultichainStore, listTrackedCollections, updateCollectionMarketStats } from "@/lib/market/multichain/store";
import { isNonEvmChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

const LIST_URL = "https://api.coingecko.com/api/v3/nfts/list";
const DETAIL_URL = "https://api.coingecko.com/api/v3/nfts";
const PAGE_SIZE = 250;

/** CoinGecko's own asset_platform_id per chain this app tracks that it also covers -- only the two chains with no OpenSea-equivalent stats path today. Real, additive coverage, not a replacement for the EVM/OpenSea path. */
const PLATFORM_BY_CHAIN: Record<string, string> = {
  "solana-mainnet": "solana",
  "bitcoin-mainnet": "ordinals",
};

type ListItem = { id: string; symbol: string | null };

function apiHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" };
}

/** Every real id CoinGecko tracks for one platform, paginated -- cached in-process per run, never persisted (this list changes daily on CoinGecko's own side; a fresh fetch each run is correct, not wasteful, since it's ~1-3 pages). */
async function fetchPlatformIds(platform: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const paced = !process.env.COINGECKO_API_KEY;
  for (let page = 1; page <= 20; page++) {
    // Real bug found live 2026-08-20: this loop had no pacing between its
    // own pages, so a platform with multiple pages of results (Ordinals'
    // real list is several hundred rows) could burn the entire
    // unauthenticated 5-15/min budget on LIST calls alone, 429-ing before
    // a single real per-collection DETAIL call ever ran. Same 4.5s pacing
    // runCoinGeckoNftStats already uses for detail calls, applied here too.
    if (paced && page > 1) await sleep(4_500);
    const res = await fetch(`${LIST_URL}?asset_platform_id=${platform}&per_page=${PAGE_SIZE}&page=${page}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`coingecko-nft-stats: ${res.status} listing ${platform}`);
    const rows = (await res.json()) as ListItem[];
    for (const r of rows) ids.add(r.id.toLowerCase());
    if (rows.length < PAGE_SIZE) break;
  }
  return ids;
}

type NftDetail = {
  volume_24h?: { native_currency?: number | null } | null;
  one_day_sales?: number | null;
  floor_price_24h_percentage_change?: { native_currency?: number | null } | null;
};

/** Same 18-decimal-equivalent wei-string convention every adapter in this app uses for a native-currency decimal amount. */
function toWeiString(decimalAmount: number | null | undefined): string | null {
  if (decimalAmount == null || !Number.isFinite(decimalAmount) || decimalAmount <= 0) return null;
  const scaled = Math.round(decimalAmount * 1e9);
  return (BigInt(scaled) * BigInt(1_000_000_000)).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type CoinGeckoNftStatsResult = {
  chainSlug: string;
  candidates: number;
  matched: number;
  updated: number;
  errors: number;
};

/**
 * Runs one pass for one chain: lists every tracked collection on that
 * chain, keeps only the ones whose OWN contract_address exactly matches
 * a real CoinGecko id for that platform, and writes real volume/sales/
 * floor-change for each real match. `maxUpdates` bounds one run's real
 * API call count (rate-limit-respecting), same "an upper bound, not a
 * target" posture every other bounded scan in this app already uses.
 */
export async function runCoinGeckoNftStats(chainSlug: string, maxUpdates = 30): Promise<CoinGeckoNftStatsResult> {
  const platform = PLATFORM_BY_CHAIN[chainSlug];
  if (!platform) throw new Error(`coingecko-nft-stats: no CoinGecko platform mapping for "${chainSlug}"`);
  if (!hasMultichainStore()) throw new Error("coingecko-nft-stats: no Postgres config.");

  const tracked = (await listTrackedCollections()).filter((c) => c.chainSlug === chainSlug);
  const realIds = await fetchPlatformIds(platform);
  // Only case-insensitive EXACT matches -- see this file's own header on
  // why fuzzy matching is refused here. isNonEvmChainSlug guards this
  // module from ever accidentally running against an EVM chain's
  // already-lowercased-by-convention addresses, which would collide with
  // real CoinGecko ids by pure coincidence far more often.
  const matches = isNonEvmChainSlug(chainSlug) ? tracked.filter((c) => realIds.has(c.contractAddress.toLowerCase())) : [];

  let updated = 0;
  let errors = 0;
  const paced = !process.env.COINGECKO_API_KEY;

  for (const collection of matches.slice(0, maxUpdates)) {
    try {
      const res = await fetch(`${DETAIL_URL}/${encodeURIComponent(collection.contractAddress.toLowerCase())}`, { headers: apiHeaders() });
      if (!res.ok) {
        errors += 1;
        continue;
      }
      const detail = (await res.json()) as NftDetail;
      const volume24hWei = toWeiString(detail.volume_24h?.native_currency);
      const sales24h = typeof detail.one_day_sales === "number" ? detail.one_day_sales : null;
      // No currentFloorPriceWei write here -- that field is populated by
      // this chain's own real fetchSnapshot adapter (unisat-collections /
      // magiceden-solana), never overwritten by this stats-only pass.
      await updateCollectionMarketStats(chainSlug, collection.contractAddress, {
        volume24hWei,
        sales24h,
        currentFloorPriceWei: null,
      });
      updated += 1;
    } catch {
      errors += 1;
    }
    if (paced) await sleep(4_500); // real 5-15/min unauthenticated limit -- 4.5s keeps this well inside it
  }

  return { chainSlug, candidates: tracked.length, matched: matches.length, updated, errors };
}
