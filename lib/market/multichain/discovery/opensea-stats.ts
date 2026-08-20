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
import { updateCollectionMarketStats, updateCollectionFloorOnly } from "@/lib/market/multichain/store";
import { durableKv as kv } from "@/lib/market/durable-kv";

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

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    recordSourceFailure(SOURCE, isQuotaError(res.status, bodyText));
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
    sales24h: typeof oneDay?.sales === "number" ? oneDay.sales : null,
  };
}

function slugCacheKey(chainSlug: string, contractAddress: string): string {
  return `plank:market:opensea-slug:${chainSlug}:${contractAddress.toLowerCase()}`;
}

export type OpenSeaStatsSyncResult = {
  chainSlug: string;
  candidates: number;
  slugResolved: number;
  updated: number;
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
  const result: OpenSeaStatsSyncResult = { chainSlug, candidates: 0, slugResolved: 0, updated: 0, errors: 0 };
  const chain = foreignChainByChainSlug(chainSlug);
  if (!chain?.openSeaChain) return result;

  const apiKey = await getOpenSeaApiKey();
  if (!apiKey) return result;

  const rows = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1 AND (s.floor_price_wei IS NULL OR s.synced_at IS NULL OR s.synced_at < NOW() - INTERVAL '6 hours')
     ORDER BY c.id
     LIMIT $2`,
    [chainSlug, maxUpdates]
  );
  result.candidates = rows.rows.length;

  for (const row of rows.rows) {
    const gate = checkSourceBudget(SOURCE);
    if (!gate.allowed) break;

    let slug = await kv.get<string>(slugCacheKey(chainSlug, row.contract_address));
    if (!slug) {
      slug = await resolveOpenSeaSlug(chain.openSeaChain, row.contract_address, apiKey);
      if (slug) await kv.set(slugCacheKey(chainSlug, row.contract_address), slug);
    }
    if (!slug) {
      result.errors += 1;
      continue;
    }
    result.slugResolved += 1;

    const stats = await fetchOpenSeaCollectionStats(slug, apiKey);
    if (!stats) {
      result.errors += 1;
      continue;
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
  }
  return result;
}
