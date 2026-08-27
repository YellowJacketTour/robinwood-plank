/**
 * Real, address-agnostic floor + 24h volume/sales for any EVM chain
 * OpenSea indexes -- built live 2026-08-20 to fix the empty Floor/24h
 * Volume cells on Polygon/BNB/Optimism/Avalanche that turned out to be
 * caused by Alchemy's NFT API sitting on a real, still-unrecovered 429
 * quota exhaustion (the same incident flagged earlier this session), not
 * anything chain-specific.
 *
 * VERIFIED LIVE, NOT ASSUMED (2026-08-20): `GET
 * /api/v2/collections/{slug}/stats` against a real Polygon collection
 * slug (resolved from opensea-bulk-scan.ts's own list response, which
 * already carries the slug for free) returned the real shape below,
 * including `intervals[].interval === "one_day"` -- the exact real 24h
 * volume/sales this app has been missing for every OpenSea-indexed EVM
 * chain, not just a floor fallback.
 *
 * EXACT SLUG ONLY: the slug consumed here always comes from OpenSea's
 * own /collections list entry for a contract this app already matched
 * on-chain, never guessed or fuzzy-resolved.
 */
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { recordOpenSeaAccountFailure } from "@/lib/market/multichain/discovery/opensea-key-pool";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { postgresQuery } from "@/lib/postgres";
import { updateCollectionMarketStats, updateCollectionFloorOnly, updateCollectionDisplay, updateCollectionSupplyFields } from "@/lib/market/multichain/store";
import { durableKv as kv } from "@/lib/market/durable-kv";
import {
  reserveOpenSeaKey,
  settleOpenSeaKey,
  loadOpenSeaKeyPool,
  OPENSEA_STATS_DAILY_ALLOWANCE,
  type OpenSeaKeyPriority,
} from "@/lib/market/multichain/discovery/opensea-key-pool";

const OPENSEA_BASE = "https://api.opensea.io/api/v2";
/** Real ceiling on the floor price this will ever accept -- same defensive bound alchemy-nft.ts's own MAX_PLAUSIBLE_FLOOR_ETH holds, guards against a corrupted/garbage response being written as a real price. */
const MAX_PLAUSIBLE_FLOOR = 100_000;

// Multi-key capacity pool moved to opensea-key-pool.ts (2026-08-23) -- every
// function below now reserves/settles against a SELECTED KEY's own provider
// account (`opensea-stats:key-N`) instead of one fixed shared account, via
// reserveOpenSeaKey/settleOpenSeaKey. OPENSEA_STATS_DAILY_ALLOWANCE is
// re-exported here for back-compat with existing importers.
export { OPENSEA_STATS_DAILY_ALLOWANCE };

type OpenSeaStatsResponse = {
  total?: { volume?: number; sales?: number; floor_price?: number; floor_price_symbol?: string; num_owners?: number };
  intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
};

export type OpenSeaCollectionStats = {
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  volume24hWei: string | null;
  sales24h: number | null;
  volume7dWei: string | null;
  sales7d: number | null;
  volume30dWei: string | null;
  sales30d: number | null;
  holderCount: number | null;
};

export type OpenSeaCollectionDisplay = {
  name: string | null;
  imageUrl: string | null;
  totalSupply: number | null;
  creatorHandle: string | null;
};

/** True when OpenSea's own `name` is just the contract (ONESHOT Avalanche pattern) — never store that as a collection title. */
export function isHexLikeCollectionName(name: string): boolean {
  const t = name.trim();
  if (/^0x[0-9a-fA-F]{8,}$/.test(t)) return true;
  if (/^[0-9a-fA-F]{40}$/.test(t)) return true;
  return false;
}

export function sanitizeOpenSeaCollectionName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.toLowerCase() === "null" || isHexLikeCollectionName(trimmed)) return null;
  return trimmed;
}

export function sanitizeOpenSeaImageUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

function toWeiString(decimalAmount: number | null | undefined): string | null {
  if (decimalAmount == null || !Number.isFinite(decimalAmount) || decimalAmount <= 0 || decimalAmount > MAX_PLAUSIBLE_FLOOR) return null;
  const scaled = Math.round(decimalAmount * 1e9); // 9 of 18 decimals now integral
  return (BigInt(scaled) * BigInt(1_000_000_000)).toString();
}

function isQuotaError(status: number, bodyText: string): boolean {
  if (status === 429) return true;
  return /rate limit|too many requests|quota/i.test(bodyText);
}

/**
 * Real address -> OpenSea slug resolution, verified live 2026-08-20:
 * `GET /api/v2/chain/{chain}/contract/{address}` returns the exact
 * collection slug for a real contract, confirmed against a real Polygon
 * collection. This is the missing piece for ALREADY-tracked collections
 * (registered by Alchemy discovery, which never learned a slug) -- the
 * bulk-list scan only yields slugs for collections it's currently
 * paging through, not ones already in the database.
 */
export async function resolveOpenSeaSlug(
  openSeaChain: string,
  contractAddress: string,
  priority: OpenSeaKeyPriority = "background"
): Promise<string | null> {
  const slot = await reserveOpenSeaKey(1, { priority });
  if (!slot) return null;

  let res: Response;
  let settled = false;
  try {
    res = await fetch(`${OPENSEA_BASE}/chain/${encodeURIComponent(openSeaChain)}/contract/${encodeURIComponent(contractAddress)}`, {
      headers: { "x-api-key": slot.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    await settleOpenSeaKey(slot, 1, true);
    settled = true;
  } catch {
    if (!settled) await settleOpenSeaKey(slot, 1, true).catch(() => {});
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    await recordOpenSeaAccountFailure(slot.providerAccount, isQuotaError(res.status, bodyText));
    return null;
  }

  let body: { collection?: string };
  try {
    body = (await res.json()) as { collection?: string };
  } catch {
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }
  recordSourceSuccess(slot.providerAccount);
  return body.collection ?? null;
}

let lastStatsNotFound = false;
function statsNoneKey(slug: string): string {
  return `plank:market:opensea-stats-none:${slug}`;
}

/** Returns null (never throws) on any real failure -- a stats miss must never break the caller's own registration flow, same discipline every other adapter in this app holds. */
export async function fetchOpenSeaCollectionStats(
  slug: string,
  priority: OpenSeaKeyPriority = "background"
): Promise<OpenSeaCollectionStats | null> {
  const slot = await reserveOpenSeaKey(1, { priority });
  if (!slot) return null;

  let res: Response;
  let settled = false;
  try {
    res = await fetch(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}/stats`, {
      headers: { "x-api-key": slot.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    await settleOpenSeaKey(slot, 1, true);
    settled = true;
  } catch {
    if (!settled) await settleOpenSeaKey(slot, 1, true).catch(() => {});
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }

  lastStatsNotFound = false;
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    await recordOpenSeaAccountFailure(slot.providerAccount, isQuotaError(res.status, bodyText));
    lastStatsNotFound = res.status === 404;
    return null;
  }

  let body: OpenSeaStatsResponse;
  try {
    body = (await res.json()) as OpenSeaStatsResponse;
  } catch {
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }
  recordSourceSuccess(slot.providerAccount);

  const oneDay = body.intervals?.find((i) => i.interval === "one_day");
  const sevenDay = body.intervals?.find((i) => i.interval === "seven_day");
  const thirtyDay = body.intervals?.find((i) => i.interval === "thirty_day");
  const positiveSales = (value: number | undefined) =>
    typeof value === "number" && value > 0 ? value : null;
  return {
    floorPriceWei: toWeiString(body.total?.floor_price),
    floorPriceCurrency: body.total?.floor_price != null && body.total.floor_price > 0 ? (body.total.floor_price_symbol || "ETH") : null,
    volume24hWei: toWeiString(oneDay?.volume),
    sales24h: positiveSales(oneDay?.sales),
    volume7dWei: toWeiString(sevenDay?.volume),
    sales7d: positiveSales(sevenDay?.sales),
    volume30dWei: toWeiString(thirtyDay?.volume),
    sales30d: positiveSales(thirtyDay?.sales),
    holderCount: typeof body.total?.num_owners === "number" && body.total.num_owners > 0
      ? Math.round(body.total.num_owners)
      : null,
  };
}

/** Exact-slug collection object — name/image only. Null fields stay null (fail closed). */
export async function fetchOpenSeaCollectionDisplay(
  slug: string,
  priority: OpenSeaKeyPriority = "background"
): Promise<OpenSeaCollectionDisplay | null> {
  const slot = await reserveOpenSeaKey(1, { priority });
  if (!slot) return null;

  let res: Response;
  let settled = false;
  try {
    res = await fetch(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}`, {
      headers: { "x-api-key": slot.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    await settleOpenSeaKey(slot, 1, true);
    settled = true;
  } catch {
    if (!settled) await settleOpenSeaKey(slot, 1, true).catch(() => {});
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    await recordOpenSeaAccountFailure(slot.providerAccount, isQuotaError(res.status, bodyText));
    return null;
  }

  let body: { name?: string | null; image_url?: string | null; total_supply?: number | null; twitter_username?: string | null };
  try {
    body = (await res.json()) as { name?: string | null; image_url?: string | null; total_supply?: number | null; twitter_username?: string | null };
  } catch {
    recordSourceFailure(slot.providerAccount, false);
    return null;
  }
  recordSourceSuccess(slot.providerAccount);
  const supply = body.total_supply;
  const handle = body.twitter_username?.trim().replace(/^@/, "") || null;
  return {
    name: sanitizeOpenSeaCollectionName(body.name),
    imageUrl: sanitizeOpenSeaImageUrl(body.image_url),
    totalSupply: typeof supply === "number" && Number.isFinite(supply) && supply > 0 ? Math.round(supply) : null,
    creatorHandle: handle && handle.toLowerCase() !== "null" ? handle : null,
  };
}

const LISTING_PAGE_SIZE = 50;

/**
 * Unique tokens with an active OpenSea listing. Exact only when pagination
 * finishes (no `next`). Truncated walks return null so a partial page is
 * never stored as if it were the full listed count.
 *
 * No self-imposed page-count ceiling: the previous MAX_LISTING_PAGES=20 cap
 * (1,000 tokens max) had no real OpenSea citation and silently returned
 * null -- "unknown listed count" -- for every collection with more than
 * 1,000 real active listings, which is exactly the popular-collection case
 * this stat matters most for. The real spend guard is already
 * reserveOpenSeaKey's per-key durable daily allowance below (returns null
 * and this function bails out once real budget is exhausted); pagination
 * itself always terminates for real data once OpenSea stops returning a
 * `next` cursor, so an unbounded walk here can't spin forever.
 */
export async function fetchOpenSeaListedCount(
  slug: string,
  openSeaChain?: string,
  priority: OpenSeaKeyPriority = "background"
): Promise<number | null> {
  const unique = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const qs = new URLSearchParams({ limit: String(LISTING_PAGE_SIZE) });
    if (openSeaChain) qs.set("chain", openSeaChain);
    if (cursor) qs.set("next", cursor);
    const slot = await reserveOpenSeaKey(1, { priority });
    if (!slot) return null;
    let res: Response;
    let settled = false;
    try {
      res = await fetch(`${OPENSEA_BASE}/listings/collection/${encodeURIComponent(slug)}/all?${qs}`, {
        headers: { "x-api-key": slot.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      await settleOpenSeaKey(slot, 1, true);
      settled = true;
    } catch {
      if (!settled) await settleOpenSeaKey(slot, 1, true).catch(() => {});
      recordSourceFailure(slot.providerAccount, false);
      return null;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      await recordOpenSeaAccountFailure(slot.providerAccount, isQuotaError(res.status, bodyText));
      return null;
    }
    let body: {
      listings?: Array<{ protocol_data?: { parameters?: { offer?: Array<{ identifierOrCriteria?: string }> } } }>;
      next?: string | null;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      recordSourceFailure(slot.providerAccount, false);
      return null;
    }
    recordSourceSuccess(slot.providerAccount);
    for (const listing of body.listings ?? []) {
      const tokenId = listing.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
      if (tokenId) unique.add(tokenId);
    }
    cursor = body.next ?? null;
    if (!cursor) return unique.size;
  }
}

export function slugCacheKey(chainSlug: string, contractAddress: string): string {
  return `plank:market:opensea-slug:${chainSlug}:${contractAddress.toLowerCase()}`;
}

export type OpenSeaStatsSyncResult = {
  chainSlug: string;
  candidates: number;
  slugResolved: number;
  updated: number;
  displayUpdated: number;
  errors: number;
};

/** Refresh one exact collection immediately for visit/repair jobs. Source budgets still apply. */
export async function syncOpenSeaCollectionStats(chainSlug: string, contractAddress: string): Promise<OpenSeaStatsSyncResult> {
  const result: OpenSeaStatsSyncResult = { chainSlug, candidates: 1, slugResolved: 0, updated: 0, displayUpdated: 0, errors: 0 };
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = chainSlug === "robinhood" ? "robinhood" : chain?.openSeaChain;
  if (!openSeaChain) return result;

  const cacheKey = slugCacheKey(chainSlug, contractAddress);
  let slug = await kv.get<string>(cacheKey);
  if (slug === "__none__") return { ...result, errors: 1 };
  if (!slug) {
    slug = await resolveOpenSeaSlug(openSeaChain, contractAddress);
    if (!slug) return { ...result, errors: 1 };
    await kv.set(cacheKey, slug);
  }
  result.slugResolved = 1;
  const stats = await fetchOpenSeaCollectionStats(slug);
  if (!stats) return { ...result, errors: 1 };
  const display = await fetchOpenSeaCollectionDisplay(slug);
  if (display && (display.name || display.imageUrl || display.creatorHandle)) {
    await updateCollectionDisplay(chainSlug, contractAddress, {
      name: display.name,
      imageUrl: display.imageUrl,
      creatorHandle: display.creatorHandle,
    }).then(() => { result.displayUpdated = 1; }).catch(() => { result.errors += 1; });
  }
  const listedCount = await fetchOpenSeaListedCount(slug, openSeaChain);
  await updateCollectionSupplyFields(chainSlug, contractAddress, {
    listedCount,
    totalSupply: display?.totalSupply ?? null,
    holderCount: stats.holderCount,
  }).catch(() => { result.errors += 1; });
  if (stats.floorPriceWei != null) {
    await updateCollectionFloorOnly(chainSlug, contractAddress, {
      floorPriceWei: stats.floorPriceWei,
      floorPriceCurrency: stats.floorPriceCurrency,
      floorPriceMarketplace: "opensea",
    }).catch(() => { result.errors += 1; });
  }
  await updateCollectionMarketStats(chainSlug, contractAddress, {
    volume24hWei: stats.volume24hWei,
    sales24h: stats.sales24h,
    volume7dWei: stats.volume7dWei,
    sales7d: stats.sales7d,
    volume30dWei: stats.volume30dWei,
    sales30d: stats.sales30d,
    currentFloorPriceWei: null,
  }).catch(() => { result.errors += 1; });
  result.updated = 1;
  return result;
}

/**
 * Real fix, live 2026-08-20, for the empty Floor/24h Volume cells on
 * every Alchemy-covered EVM chain traced back to Alchemy's own
 * still-unrecovered NFT-API 429 -- backfills ALREADY-tracked
 * collections (registered by Alchemy discovery, which never learned an
 * OpenSea slug) via resolveOpenSeaSlug + fetchOpenSeaCollectionStats,
 * an entirely separate real source with its own circuit breaker
 * (SOURCE="opensea-stats"), independent of Alchemy's exhausted quota.
 * Resolved slugs are cached in durable-kv (same store
 * opensea-bulk-scan.ts's own cursor uses) so a contract's slug is
 * resolved once, not re-resolved every sync pass.
 */
export async function runOpenSeaStatsSync(chainSlug: string, maxUpdates = 25): Promise<OpenSeaStatsSyncResult> {
  const result: OpenSeaStatsSyncResult = { chainSlug, candidates: 0, slugResolved: 0, updated: 0, displayUpdated: 0, errors: 0 };
  const chain = foreignChainByChainSlug(chainSlug);
  const openSeaChain = chainSlug === "robinhood" ? "robinhood" : chain?.openSeaChain;
  if (!openSeaChain) return result;

  const pool = await loadOpenSeaKeyPool();
  if (pool.length === 0) return result;

  const NO_SLUG = "__none__";
  const cursorKey = `plank:market:opensea-stats-cursor:${chainSlug}`;
  const afterId = (await kv.get<number>(cursorKey)) ?? 0;
  const rows = await postgresQuery<{ id: number; contract_address: string }>(
    `SELECT c.id, c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1 AND c.id > $2 AND (
       s.floor_price_wei IS NULL
       OR s.synced_at IS NULL
       OR s.synced_at < NOW() - INTERVAL '6 hours'
       OR c.name IS NULL
       OR c.image_url IS NULL
       OR s.listed_count IS NULL
     )
     -- Missing display metadata must outrank periodic refreshes of rows that
     -- are already usable.  The old ordering did the reverse, so a large
     -- catalog could permanently starve newly discovered contract shells.
     ORDER BY (c.name IS NULL OR c.name ILIKE '0x%' OR c.image_url IS NULL) DESC, c.id
     LIMIT $3`,
    [chainSlug, afterId, Math.max(maxUpdates * 40, 200)]
  );
  result.candidates = rows.rows.length;
  if (rows.rows.length === 0) {
    await kv.set(cursorKey, 0);
    return result;
  }

  const anyKeyAvailable = () => pool.some((entry) => checkSourceBudget(entry.providerAccount).allowed);

  let processed = 0;
  let lastSeenId = afterId;
  for (const row of rows.rows) {
    if (processed >= maxUpdates) break;
    if (!anyKeyAvailable()) break;

    const cacheKey = slugCacheKey(chainSlug, row.contract_address);
    let slug = await kv.get<string>(cacheKey);
    if (slug === NO_SLUG) {
      result.errors += 1;
      lastSeenId = row.id;
      continue;
    }
    if (!slug) {
      slug = await resolveOpenSeaSlug(openSeaChain, row.contract_address);
      if (!slug) {
        if (!anyKeyAvailable()) break;
        await kv.set(cacheKey, NO_SLUG);
        result.errors += 1;
        lastSeenId = row.id;
        continue;
      }
      await kv.set(cacheKey, slug);
    }
    const noneKey = statsNoneKey(slug);
    if ((await kv.get<string>(noneKey)) === "1") {
      result.errors += 1;
      lastSeenId = row.id;
      continue;
    }

    result.slugResolved += 1;
    processed += 1;

    const stats = await fetchOpenSeaCollectionStats(slug);
    if (!stats) {
      if (lastStatsNotFound) await kv.set(noneKey, "1").catch(() => {});
      result.errors += 1;
      lastSeenId = row.id;
      continue;
    }
    const display = await fetchOpenSeaCollectionDisplay(slug);
    if (display && (display.name || display.imageUrl || display.creatorHandle)) {
      await updateCollectionDisplay(chainSlug, row.contract_address, {
        name: display.name,
        imageUrl: display.imageUrl,
        creatorHandle: display.creatorHandle,
      }).then(() => {
        result.displayUpdated += 1;
      }).catch(() => {
        result.errors += 1;
      });
    }
    const listedCount = await fetchOpenSeaListedCount(slug, openSeaChain);
    if (listedCount != null || display?.totalSupply != null) {
      await updateCollectionSupplyFields(chainSlug, row.contract_address, {
        listedCount,
        totalSupply: display?.totalSupply ?? null,
        holderCount: stats.holderCount,
      }).catch(() => {
        result.errors += 1;
      });
    }
    if (stats.floorPriceWei != null) {
      await updateCollectionFloorOnly(chainSlug, row.contract_address, {
        floorPriceWei: stats.floorPriceWei,
        floorPriceCurrency: stats.floorPriceCurrency,
        floorPriceMarketplace: "opensea",
      }).catch(() => {
        result.errors += 1;
      });
    }
    if (stats.volume24hWei != null || stats.sales24h != null || stats.volume7dWei != null || stats.sales7d != null
      || stats.volume30dWei != null || stats.sales30d != null) {
      await updateCollectionMarketStats(chainSlug, row.contract_address, {
        volume24hWei: stats.volume24hWei,
        sales24h: stats.sales24h,
        volume7dWei: stats.volume7dWei,
        sales7d: stats.sales7d,
        volume30dWei: stats.volume30dWei,
        sales30d: stats.sales30d,
        currentFloorPriceWei: null,
      }).catch(() => {
        result.errors += 1;
      });
    }
    result.updated += 1;
    lastSeenId = row.id;
  }
  if (lastSeenId !== afterId) await kv.set(cursorKey, lastSeenId);
  return result;
}
