/**
 * UniSat adapter for discovery + snapshot sync -- Bitcoin Ordinals'
 * ChainAdapter counterpart to magiceden-solana.ts. Kept separate from
 * unisat-ordinals-trade.ts on purpose: that file is the buy/bid execution
 * path (PSBT construction, signing, confirm), this one is read-only
 * ranking/stats, same split as Magic Eden's own two files.
 *
 * Verified live 2026-08-18 (UNISAT_API_KEY required, unlike Magic Eden's
 * public stats-search):
 *
 * POST /v3/market/collection/auction/collection_statistic_list
 *   body: {start, limit, filter: {timeType}} -- `filter` looked optional
 *   from the OpenAPI schema (additionalProperties:false, no `required` at
 *   the top level despite the spec listing `filter.timeType` as required
 *   *inside* filter) but omitting it returns a real 500 from the server,
 *   not a validation error -- confirmed live, not guessed. `timeType` only
 *   returns a non-empty list for "24h" and "7d"; every other value tried
 *   ("1d", "day", "week", "1", "0") returns an empty list with code 0 (a
 *   real "no data for this window" response, not an error).
 *   `limit` is capped at 20 (exclusiveMaximum 21 in the real schema) --
 *   this file paginates via `start` to satisfy a larger request.
 *
 *   IMPORTANT, DISCLOSED LIMITATION: this endpoint has no sort/metric
 *   parameter at all (confirmed against the real request schema --
 *   `additionalProperties: false` with only `filter`, `start`, `limit`).
 *   The API returns one fixed ranking order for a given timeType with no
 *   way to ask for "by volume" vs "by floor price" separately, unlike
 *   Magic Eden's endpoint. This adapter therefore returns the SAME order
 *   for both metrics rather than inventing a client-side sort the API
 *   itself doesn't expose -- documented here instead of silently sorting
 *   by a field that would look like ground truth but isn't the API's own
 *   ranking.
 *
 * POST /v3/market/collection/auction/collection_statistic
 *   body: {collectionId} -- single-collection version of the same shape.
 *
 * `floorPrice`/`btcValue` are both integer satoshis. `icon` is EITHER a
 * real https URL OR a raw inscription id (64-hex + "i" + index, e.g.
 * "d19981a1...b7i0") that has no HTTP scheme at all -- confirmed live
 * against bitcoin-frogs, whose icon is the latter. ordinals.com/content/
 * is the standard, keyless, public Ordinals content gateway used to
 * resolve that case.
 */
import type { ChainAdapter, CollectionSnapshot, DiscoveredCollection } from "@/lib/market/multichain/types";

const API_BASE = "https://open-api.unisat.io/v3/market/collection/auction";
const PAGE_SIZE = 20; // real, confirmed server-enforced max (exclusiveMaximum 21)

type UniSatCollectionEntry = {
  collectionId: string;
  name?: string | null;
  icon?: string | null;
  btcValue?: number | null;
  floorPrice?: number | null;
  listed?: number | null;
  total?: number | null;
  supply?: number | null;
  holders?: number | null;
  uniqueHolders?: number | null;
};

function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY;
  if (!key) throw new Error("unisat-collections: UNISAT_API_KEY is not configured");
  return key;
}

async function unisatFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = requireApiKey();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`unisat-collections: ${res.status} ${res.statusText} on ${path} -- ${text.slice(0, 200)}`);
  }
  const envelope = (await res.json()) as { code: number | string; msg: string; data: T };
  if (envelope.code !== 0) {
    throw new Error(`unisat-collections: ${path} returned code ${envelope.code} -- ${envelope.msg}`);
  }
  return envelope.data;
}

/** Real inscription-content gateway resolution for the raw-inscription-id icon case -- see header. */
function resolveIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  if (/^https?:\/\//i.test(icon)) return icon;
  return `https://ordinals.com/content/${icon}`;
}

/**
 * Stored as an 18-decimal-equivalent string alongside every other chain's
 * price, same convention as magiceden-solana.ts's lamportsToScaledString.
 * Satoshis are 8dp, so *1e10 reaches 18dp -- done in BigInt to avoid float
 * drift on values this large.
 */
function satsToScaledString(sats: number): string | null {
  if (!Number.isFinite(sats) || sats <= 0) return null;
  return (BigInt(Math.round(sats)) * BigInt(10_000_000_000)).toString();
}

/**
 * discoverTopCollections gets called once per metric ("volume" then
 * "floorPrice") by discover-multichain-collections.ts, and -- per this
 * file's header -- both calls hit the exact same real API pages in the
 * exact same order, since the endpoint has no sort parameter at all. A
 * tiny in-process cache keyed by (timeType, limit) means the second call
 * replays the first's already-fetched pages instead of doubling real,
 * metered API cost for identical data. Module-level and unbounded on
 * purpose: this adapter's process (the discovery/sync script) runs once
 * and exits, so there is no unbounded-growth risk to guard against.
 */
const discoveryCache = new Map<string, Promise<DiscoveredCollection[]>>();

async function fetchTopCollections(limit: number): Promise<DiscoveredCollection[]> {
  const out: DiscoveredCollection[] = [];
  let start = 0;
  while (out.length < limit) {
    const page = Math.min(PAGE_SIZE, limit - out.length);
    const data = await unisatFetch<{ list: UniSatCollectionEntry[]; total: number }>("/collection_statistic_list", {
      start,
      limit: page,
      filter: { timeType: "24h" },
    });
    for (const entry of data.list) {
      out.push({
        contractAddress: entry.collectionId,
        name: entry.name ?? null,
        imageUrl: resolveIconUrl(entry.icon),
        // No independent volume/floor ranking from this endpoint -- see
        // header. Both metrics get the same real API-returned order.
        volumeRank: out.length + 1,
        floorPriceRank: out.length + 1,
      });
    }
    start += page;
    if (data.list.length < page || start >= data.total) break;
  }
  return out;
}

export const unisatCollectionsAdapter: ChainAdapter = {
  name: "unisat-collections",
  async discoverTopCollections({ limit }): Promise<DiscoveredCollection[]> {
    const key = `24h:${limit}`;
    let pending = discoveryCache.get(key);
    if (!pending) {
      pending = fetchTopCollections(limit);
      discoveryCache.set(key, pending);
    }
    try {
      return await pending;
    } catch (error) {
      discoveryCache.delete(key); // don't poison the cache with a failed run -- let the next call retry live
      throw error;
    }
  },
  async fetchSnapshot({ contractAddress: collectionId }): Promise<CollectionSnapshot> {
    const entry = await unisatFetch<UniSatCollectionEntry>("/collection_statistic", { collectionId });
    let holders: number | null = null;
    if (typeof entry.holders === "number" && entry.holders > 0) holders = entry.holders;
    else if (typeof entry.uniqueHolders === "number" && entry.uniqueHolders > 0) holders = entry.uniqueHolders;
    if (holders == null) {
      holders = await fetchUnisatHolderTotal(collectionId);
    }
    return {
      name: entry.name ?? null,
      imageUrl: resolveIconUrl(entry.icon),
      externalUrl: `https://unisat.io/market/collection/${collectionId}`,
      floorPriceWei: entry.floorPrice != null ? satsToScaledString(entry.floorPrice) : null,
      floorPriceCurrency: "BTC",
      floorPriceMarketplace: "unisat",
      totalSupply: entry.total ?? entry.supply ?? null,
      listedCount: entry.listed ?? null,
      holderCount: holders,
    };
  },
};

async function fetchUnisatHolderTotal(collectionId: string): Promise<number | null> {
  const key = process.env.UNISAT_API_KEY;
  if (!key) return null;
  const res = await fetch(
    `https://open-api.unisat.io/v1/collection-indexer/collection/${encodeURIComponent(collectionId)}/holders?start=0&limit=1`,
    {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }
  ).catch(() => null);
  if (!res?.ok) return null;
  const envelope = (await res.json().catch(() => null)) as { code?: number; data?: { total?: number } } | null;
  const total = envelope?.data?.total;
  return typeof total === "number" && total > 0 ? total : null;
}
