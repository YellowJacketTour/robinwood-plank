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
import {
  hasMultichainStore,
  updateCollectionMarketStats,
  updateCollectionFloorOnly,
  updateCollectionDisplay,
  updateHolderCount,
  upsertTrackedCollection,
} from "@/lib/market/multichain/store";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isNonEvmChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { durableKv } from "@/lib/market/durable-kv";
import { postgresQuery } from "@/lib/postgres";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";

/** This source's own budget-tracker key -- see source-budget.ts's own header for the real incident (Alchemy's monthly quota) this whole mechanism exists to prevent from happening again, to a different source, silently. */
const SOURCE = "coingecko-nft";

/**
 * Real, PERSISTENT monthly cap, added live 2026-08-20 the same session a
 * real COINGECKO_API_KEY (free Demo tier) was wired in for the first
 * time -- source-budget.ts's own DAILY_CEILING is real but lives in
 * in-memory `globalThis` state, which does NOT survive a process
 * restart. This app's own sync scripts (coingecko-nft-stats-sync-pass.mjs
 * + its supervisor) are SHORT bounded passes relaunched every few
 * minutes for up to 24h BY DESIGN (crash resilience) -- meaning the
 * in-memory daily ceiling resets on every single relaunch and provides
 * ZERO real protection against exceeding CoinGecko's own real monthly
 * cap (10,000/mo on the free Demo tier, confirmed in this file's own
 * header) across a day of repeated passes. This table-backed counter is
 * the real, durable guard: checked BEFORE every real request, same
 * fail-closed discipline as checkSourceBudget.
 */
/**
 * NO MULTI-KEY POOL BUILT FOR COINGECKO (doc check re-confirmed 2026-08-23,
 * consistent with what this file already documents above): CoinGecko's
 * Demo-tier key raises the rate limit for the ACCOUNT that registered it,
 * not per key -- the same account-bound constraint opensea-key-pool.ts's
 * header documents for OpenSea. Multiple Demo keys minted under one
 * CoinGecko account would not multiply real capacity; only keys from
 * separate CoinGecko accounts would. Given the free/no-cost nature of a
 * Demo key and the low call volume this module needs (well under even one
 * account's 10,000/mo), building and maintaining a pool here has no real
 * payoff today. If that changes, follow opensea-key-pool.ts's exact
 * pattern (COINGECKO_API_KEYS, position-based ids, least/most-loaded
 * selection).
 */
const MONTHLY_CEILING = 9_000; // real margin under CoinGecko's documented 10,000/mo Demo cap

/** Matches source-budget.ts's own DAILY_CEILING["coingecko-nft"] exactly -- this only adds cross-process durability on top of the existing in-memory ceiling and the monthly-KV guard above, never changes what the daily ceiling actually is. */
const CG_DAILY_ALLOWANCE = 8_000;
const CG_PROVIDER_ACCOUNT = "coingecko-nft:default";

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function peekMonthlyBudget(): Promise<number> {
  if (!process.env.COINGECKO_API_KEY) return 0;
  const key = `plank:market:coingecko-nft-monthly-v3:${monthKey()}`;
  return (await durableKv.get<number>(key)) ?? 0;
}

async function checkAndIncrementMonthlyBudget(): Promise<boolean> {
  if (!process.env.COINGECKO_API_KEY) return true; // unauthenticated tier has no monthly cap to protect, only the in-memory daily/jail guard applies
  const key = `plank:market:coingecko-nft-monthly-v3:${monthKey()}`;
  // Read-then-write against plank_kv_values (durable-kv.ts's real, already-
  // existing table -- no new migration needed). This app's own sync loops
  // call CoinGecko sequentially, never concurrently, so the narrow race
  // window here is a real but low-severity risk, not a correctness gap
  // worth a bespoke atomic-increment migration for a soft safety margin
  // that's already conservative (9,000 vs the real 10,000 cap).
  const current = (await durableKv.get<number>(key)) ?? 0;
  const next = current + 1;
  await durableKv.set(key, next, { ex: 40 * 24 * 60 * 60 }); // 40-day TTL, comfortably outlives any one calendar month
  return next <= MONTHLY_CEILING;
}

/** A 429, or any response body containing a real rate-limit/quota phrase CoinGecko is confirmed to use -- distinguishes "this specific call failed" from "this whole source is now hot and every further call this window will fail too," which is exactly the live incident (unpaced LIST pagination) this session actually hit. */
function isQuotaError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  const lower = bodyText.toLowerCase();
  return lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("quota");
}

const LIST_URL = "https://api.coingecko.com/api/v3/nfts/list";
const DETAIL_URL = "https://api.coingecko.com/api/v3/nfts";
const PAGE_SIZE = 250;

/** CoinGecko asset_platform_id. OS remains primary for EVM; CG walks the rest so every tracked/CG-listed collection can get a sourced floor. */
const PLATFORM_BY_CHAIN: Record<string, string> = {
  "solana-mainnet": "solana",
  "bitcoin-mainnet": "ordinals",
  "bnb-mainnet": "binance-smart-chain",
  "avax-mainnet": "avalanche",
  "eth-mainnet": "ethereum",
  "polygon-mainnet": "polygon-pos",
  "base-mainnet": "base",
  "arb-mainnet": "arbitrum-one",
  "opt-mainnet": "optimistic-ethereum",
};

type ListItem = { id: string; symbol: string | null; contract_address?: string | null; name?: string | null };

function apiHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" };
}

/** Every real id CoinGecko tracks for one platform, paginated -- cached in-process per run, never persisted (this list changes daily on CoinGecko's own side; a fresh fetch each run is correct, not wasteful, since it's ~1-3 pages). */
async function fetchPlatformList(platform: string): Promise<ListItem[]> {
  const out: ListItem[] = [];
  const paced = !process.env.COINGECKO_API_KEY;
  for (let page = 1; page <= 20; page++) {
    // Real bug found live 2026-08-20: this loop had no pacing between its
    // own pages, so a platform with multiple pages of results (Ordinals'
    // real list is several hundred rows) could burn the entire
    // unauthenticated 5-15/min budget on LIST calls alone, 429-ing before
    // a single real per-collection DETAIL call ever ran. Same 4.5s pacing
    // runCoinGeckoNftStats already uses for detail calls, applied here too.
    if (paced && page > 1) await sleep(4_500);

    // Circuit breaker, checked BEFORE the real request -- if a prior call
    // this window already jailed this source (429 / daily ceiling), stop
    // paginating immediately rather than burning more of the (already
    // exhausted) budget finding that out the hard way per-page.
    const gate = checkSourceBudget(SOURCE);
    if (!gate.allowed) {
      throw new Error(`coingecko-nft-stats: source jailed/exhausted (${gate.reason}) -- stopping platform list fetch for "${platform}" early, ${out.length} id(s) collected so far`);
    }
    const window = utcDayWindow(CG_DAILY_ALLOWANCE);
    if (!(await reserveProviderCapacity(CG_PROVIDER_ACCOUNT, window))) {
      throw new Error(`coingecko-nft-stats: durable daily ceiling -- stopping platform list fetch for "${platform}" early, ${out.length} id(s) collected so far`);
    }
    let res: Response;
    let settled = false;
    try {
      res = await fetch(`${LIST_URL}?asset_platform_id=${platform}&per_page=${PAGE_SIZE}&page=${page}`, { headers: apiHeaders(), signal: AbortSignal.timeout(15_000) });
      await settleProviderCapacity(CG_PROVIDER_ACCOUNT, window, 1, true);
      settled = true;
    } catch (error) {
      if (!settled) await settleProviderCapacity(CG_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
      throw error;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
      throw new Error(`coingecko-nft-stats: ${res.status} listing ${platform}`);
    }
    recordSourceSuccess(SOURCE);
    const rows = (await res.json()) as ListItem[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

type NftDetail = {
  volume_24h?: { native_currency?: number | null } | null;
  one_day_sales?: number | null;
  floor_price?: { native_currency?: number | null } | null;
  floor_price_24h_percentage_change?: { native_currency?: number | null } | null;
  number_of_unique_addresses?: number | null;
  total_supply?: number | null;
  name?: string | null;
  image?: { small?: string | null; small_2x?: string | null; large?: string | null } | null;
};

/** Same 18-decimal-equivalent wei-string convention every adapter in this app uses for a native-currency decimal amount. */
/** Same ceiling opensea-stats.ts and alchemy-nft.ts enforce (AUDIT lens 1 fabrication, 2026-09-06): a garbage vendor value must never become a real floor. */
const MAX_PLAUSIBLE_FLOOR = 100_000;
function toWeiString(decimalAmount: number | null | undefined): string | null {
  if (decimalAmount == null || !Number.isFinite(decimalAmount) || decimalAmount <= 0 || decimalAmount > MAX_PLAUSIBLE_FLOOR) return null;
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
  skipReason?: string;
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

  const monthlyUsed = await peekMonthlyBudget();
  if (process.env.COINGECKO_API_KEY && monthlyUsed >= MONTHLY_CEILING) {
    return { chainSlug, candidates: 0, matched: 0, updated: 0, errors: 0, skipReason: `monthly-cap ${monthlyUsed}` };
  }

  const catalog = await fetchPlatformList(platform);
  const missing = await postgresQuery<{ contract_address: string; name: string | null }>(
    `SELECT c.contract_address, c.name
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1
       AND (s.floor_price_wei IS NULL OR s.floor_price_wei = '0')
     ORDER BY c.id
     LIMIT 8000`,
    [chainSlug]
  );
  const trackedMissing = missing.rows;
  const trackedCount = (
    await postgresQuery<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM plank_multichain_collections WHERE chain_slug = $1`,
      [chainSlug]
    )
  ).rows[0]?.n;

  type Job = { contractAddress: string; cgId: string; name: string | null; foreignChainId?: number | null };
  const jobs: Job[] = [];
  const seen = new Set<string>();
  if (isNonEvmChainSlug(chainSlug)) {
    const ids = new Set(catalog.map((r) => r.id.toLowerCase()));
    for (const c of trackedMissing) {
      const key = c.contract_address.toLowerCase();
      if (!ids.has(key) || seen.has(key)) continue;
      seen.add(key);
      jobs.push({ contractAddress: c.contract_address, cgId: key, name: c.name });
    }
  } else {
    const byAddr = new Map<string, ListItem>();
    for (const row of catalog) {
      if (row.contract_address) byAddr.set(row.contract_address.toLowerCase(), row);
    }
    for (const c of trackedMissing) {
      const hit = byAddr.get(c.contract_address.toLowerCase());
      if (!hit || seen.has(c.contract_address.toLowerCase())) continue;
      seen.add(c.contract_address.toLowerCase());
      jobs.push({ contractAddress: c.contract_address, cgId: hit.id, name: hit.name ?? c.name });
    }
    const foreign = foreignChainByChainSlug(chainSlug);
    const floored = await postgresQuery<{ contract_address: string }>(
      `SELECT c.contract_address
       FROM plank_multichain_collections c
       JOIN plank_multichain_snapshots s ON s.collection_id = c.id
       WHERE c.chain_slug = $1 AND s.floor_price_wei IS NOT NULL AND s.floor_price_wei <> '0'`,
      [chainSlug]
    );
    const hasFloor = new Set(floored.rows.map((r) => r.contract_address.toLowerCase()));
    const cursorKey = `plank:market:coingecko-catalog-cursor:${chainSlug}`;
    let cursor = (await durableKv.get<number>(cursorKey)) ?? 0;
    if (cursor >= catalog.length) cursor = 0;
    // Queue catalog rows for THIS pass only. Upsert happens on a successful
    // detail fetch — registering shells while the monthly cap is spent
    // inflates chip counts with empty books (live 2026-08-20).
    for (let i = 0; i < catalog.length && jobs.length < maxUpdates; i++) {
      const row = catalog[(cursor + i) % catalog.length];
      const addr = row.contract_address?.toLowerCase();
      if (!addr || seen.has(addr) || !row.id || hasFloor.has(addr)) continue;
      seen.add(addr);
      jobs.push({ contractAddress: addr, cgId: row.id, name: row.name ?? null, foreignChainId: foreign?.chainId ?? null });
    }
    await durableKv.set(cursorKey, (cursor + Math.max(jobs.length, 1)) % Math.max(catalog.length, 1), {
      ex: 40 * 24 * 60 * 60,
    });
  }
  const matches = jobs;

  let updated = 0;
  let errors = 0;
  const paced = !process.env.COINGECKO_API_KEY;

  for (const collection of matches.slice(0, maxUpdates)) {
    // Circuit breaker, checked BEFORE every real request -- a jailed or
    // daily-exhausted source stops this loop immediately rather than
    // continuing to spend the remaining `matches` entries hitting a
    // source already known to be failing/quota'd this window.
    const gate = checkSourceBudget(SOURCE);
    if (!gate.allowed) break;
    if (!(await checkAndIncrementMonthlyBudget())) break;

    const window = utcDayWindow(CG_DAILY_ALLOWANCE);
    if (!(await reserveProviderCapacity(CG_PROVIDER_ACCOUNT, window))) break;
    let settled = false;
    try {
      const res = await fetch(`${DETAIL_URL}/${encodeURIComponent(collection.cgId)}`, { headers: apiHeaders(), signal: AbortSignal.timeout(15_000) });
      await settleProviderCapacity(CG_PROVIDER_ACCOUNT, window, 1, true);
      settled = true;
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
        errors += 1;
        continue;
      }
      recordSourceSuccess(SOURCE);
      const detail = (await res.json()) as NftDetail;
      await upsertTrackedCollection({
        chainSlug,
        chainId: collection.foreignChainId ?? foreignChainByChainSlug(chainSlug)?.chainId ?? null,
        contractAddress: collection.contractAddress,
        adapter: "coingecko-nft",
      });
      const volume24hWei = toWeiString(detail.volume_24h?.native_currency);
      const sales24h = typeof detail.one_day_sales === "number" ? detail.one_day_sales : null;
      const change = detail.floor_price_24h_percentage_change?.native_currency;
      const floorChangePct = typeof change === "number" && Number.isFinite(change) && change !== 0 ? change : null;
      const floorWei = toWeiString(detail.floor_price?.native_currency);
      const native =
        foreignChainByChainSlug(chainSlug)?.nativeCurrencySymbol ??
        (chainSlug === "solana-mainnet" ? "SOL" : chainSlug === "bitcoin-mainnet" ? "BTC" : "BNB");
      if (floorWei) {
        await updateCollectionFloorOnly(chainSlug, collection.contractAddress, {
          floorPriceWei: floorWei,
          floorPriceCurrency: native,
          floorPriceMarketplace: "coingecko",
        });
      }
      if (collection.name) {
        await updateCollectionDisplay(chainSlug, collection.contractAddress, {
          name: collection.name,
          imageUrl: preferHighestResImageUrl(detail.image?.small_2x || detail.image?.small) ?? detail.image?.small ?? null,
        }).catch(() => {});
      }
      if (typeof detail.number_of_unique_addresses === "number" && detail.number_of_unique_addresses > 0) {
        await updateHolderCount(chainSlug, collection.contractAddress, detail.number_of_unique_addresses).catch(() => {});
      }
      await updateCollectionMarketStats(chainSlug, collection.contractAddress, {
        volume24hWei,
        sales24h,
        currentFloorPriceWei: null,
        floorChangePct,
      });
      updated += 1;
    } catch {
      // A network-level throw (timeout, DNS, etc.) never reached a real
      // HTTP response, so it's a generic failure, not a confirmed quota
      // error -- the 3-consecutive-failure threshold handles a source
      // that's genuinely down without jailing it on the first hiccup.
      if (!settled) await settleProviderCapacity(CG_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
      recordSourceFailure(SOURCE, false);
      errors += 1;
    }
    if (paced) await sleep(4_500); // real 5-15/min unauthenticated limit -- 4.5s keeps this well inside it
  }

  return { chainSlug, candidates: Number(trackedCount ?? 0), matched: matches.length, updated, errors };
}
