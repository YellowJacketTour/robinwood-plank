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
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { postgresQuery } from "@/lib/postgres";
import { updateCollectionMarketStats, updateCollectionFloorOnly, updateCollectionDisplay, updateCollectionSupplyFields } from "@/lib/market/multichain/store";
import { durableKv as kv } from "@/lib/market/durable-kv";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";

const SOURCE = "opensea-stats";
const OPENSEA_BASE = "https://api.opensea.io/api/v2";
/** Real ceiling on the floor price this will ever accept -- same defensive bound alchemy-nft.ts's own MAX_PLAUSIBLE_FLOOR_ETH holds, guards against a corrupted/garbage response being written as a real price. */
const MAX_PLAUSIBLE_FLOOR = 100_000;

type OpenSeaStatsResponse = {
  total?: { volume?: number; sales?: number; floor_price?: number; floor_price_symbol?: string };
  intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
};

export type OpenSeaCollectionStats = {
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  volume24hWei: string | null;
  sales24h: number | null;
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
    return preferHighestResImageUrl(trimmed) ?? trimmed;
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
export async function resolveOpenSeaSlug(openSeaChain: string, contractAddress: string, apiKey: string): Promise<string | null> {
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) return null;

  let res: Response;
  try {
    res = await fetch(`${OPENSEA_BASE}/chain/${encodeURIComponent(openSeaChain)}/contract/${encodeURIComponent(contractAddress)}`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
    return null;
  }

  let body: { collection?: string };
  try {
    body = (await res.json()) as { collection?: string };
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }
  recordSourceSuccess(SOURCE);
  return body.collection ?? null;
}

let lastStatsNotFound = false;
function statsNoneKey(slug: string): string {
  return `plank:market:opensea-stats-none:${slug}`;
}

/** Returns null (never throws) on any real failure -- a stats miss must never break the caller's own registration flow, same discipline every other adapter in this app holds. */
export async function fetchOpenSeaCollectionStats(slug: string, apiKey: string): Promise<OpenSeaCollectionStats | null> {
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) return null;

  let res: Response;
  try {
    res = await fetch(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}/stats`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }

  lastStatsNotFound = false;
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
    lastStatsNotFound = res.status === 404;
    return null;
  }

  let body: OpenSeaStatsResponse;
  try {
    body = (await res.json()) as OpenSeaStatsResponse;
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }
  recordSourceSuccess(SOURCE);

  const oneDay = body.intervals?.find((i) => i.interval === "one_day");
  return {
    floorPriceWei: toWeiString(body.total?.floor_price),
    floorPriceCurrency: body.total?.floor_price != null && body.total.floor_price > 0 ? (body.total.floor_price_symbol || "ETH") : null,
    volume24hWei: toWeiString(oneDay?.volume),
    sales24h: typeof oneDay?.sales === "number" && oneDay.sales > 0 ? oneDay.sales : null,
  };
}

/** Exact-slug collection object — name/image only. Null fields stay null (fail closed). */
export async function fetchOpenSeaCollectionDisplay(slug: string, apiKey: string): Promise<OpenSeaCollectionDisplay | null> {
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) return null;

  let res: Response;
  try {
    res = await fetch(`${OPENSEA_BASE}/collections/${encodeURIComponent(slug)}`, {
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
    return null;
  }

  let body: { name?: string | null; image_url?: string | null; total_supply?: number | null; twitter_username?: string | null };
  try {
    body = (await res.json()) as { name?: string | null; image_url?: string | null; total_supply?: number | null; twitter_username?: string | null };
  } catch {
    recordSourceFailure(SOURCE, false);
    return null;
  }
  recordSourceSuccess(SOURCE);
  const supply = body.total_supply;
  const handle = body.twitter_username?.trim().replace(/^@/, "") || null;
  return {
    name: sanitizeOpenSeaCollectionName(body.name),
    imageUrl: sanitizeOpenSeaImageUrl(body.image_url),
    totalSupply: typeof supply === "number" && Number.isFinite(supply) && supply > 0 ? Math.round(supply) : null,
    creatorHandle: handle && handle.toLowerCase() !== "null" ? handle : null,
  };
}

const MAX_LISTING_PAGES = 20;
const LISTING_PAGE_SIZE = 50;

/**
 * Unique tokens with an active OpenSea listing. Exact only when pagination
 * finishes (no `next`). Truncated walks return null so a partial page is
 * never stored as if it were the full listed count.
 */
export async function fetchOpenSeaListedCount(slug: string, apiKey: string): Promise<number | null> {
  const unique = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LISTING_PAGES; page++) {
    const gate = checkSourceBudget(SOURCE);
    if (!gate.allowed) return null;
    const qs = new URLSearchParams({ limit: String(LISTING_PAGE_SIZE) });
    if (cursor) qs.set("next", cursor);
    let res: Response;
    try {
      res = await fetch(`${OPENSEA_BASE}/listings/collection/${encodeURIComponent(slug)}/all?${qs}`, {
        headers: { "x-api-key": apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      recordSourceFailure(SOURCE, false);
      return null;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
      return null;
    }
    let body: {
      listings?: Array<{ protocol_data?: { parameters?: { offer?: Array<{ identifierOrCriteria?: string }> } } }>;
      next?: string | null;
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      recordSourceFailure(SOURCE, false);
      return null;
    }
    recordSourceSuccess(SOURCE);
    for (const listing of body.listings ?? []) {
      const tokenId = listing.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria;
      if (tokenId) unique.add(tokenId);
    }
    cursor = body.next ?? null;
    if (!cursor) return unique.size;
  }
  return null;
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
  if (!chain?.openSeaChain) return result;

  const apiKey = await getOpenSeaApiKey();
  if (!apiKey) return result;

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
     ORDER BY (c.name IS NOT NULL AND c.name NOT ILIKE '0x%') DESC, c.id
     LIMIT $3`,
    [chainSlug, afterId, Math.max(maxUpdates * 40, 200)]
  );
  result.candidates = rows.rows.length;
  if (rows.rows.length === 0) {
    await kv.set(cursorKey, 0);
    return result;
  }

  let processed = 0;
  let lastSeenId = afterId;
  for (const row of rows.rows) {
    if (processed >= maxUpdates) break;
    const gate = checkSourceBudget(SOURCE);
    if (!gate.allowed) break;

    const cacheKey = slugCacheKey(chainSlug, row.contract_address);
    let slug = await kv.get<string>(cacheKey);
    if (slug === NO_SLUG) {
      result.errors += 1;
      lastSeenId = row.id;
      continue;
    }
    if (!slug) {
      slug = await resolveOpenSeaSlug(chain.openSeaChain, row.contract_address, apiKey);
      if (!slug) {
        const still = checkSourceBudget(SOURCE);
        if (!still.allowed) break;
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

    const stats = await fetchOpenSeaCollectionStats(slug, apiKey);
    if (!stats) {
      if (lastStatsNotFound) await kv.set(noneKey, "1").catch(() => {});
      result.errors += 1;
      lastSeenId = row.id;
      continue;
    }
    const display = await fetchOpenSeaCollectionDisplay(slug, apiKey);
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
    const listedCount = await fetchOpenSeaListedCount(slug, apiKey);
    if (listedCount != null || display?.totalSupply != null) {
      await updateCollectionSupplyFields(chainSlug, row.contract_address, {
        listedCount,
        totalSupply: display?.totalSupply ?? null,
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
    if (stats.volume24hWei != null || stats.sales24h != null) {
      await updateCollectionMarketStats(chainSlug, row.contract_address, {
        volume24hWei: stats.volume24hWei,
        sales24h: stats.sales24h,
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
