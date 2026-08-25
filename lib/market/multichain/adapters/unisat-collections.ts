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
import {
  upsertTrackedCollection,
  updateCollectionDisplay,
  updateCollectionFloorOnly,
  updateCollectionSupplyFields,
  updateHolderCount,
} from "@/lib/market/multichain/store";
import { postgresQuery } from "@/lib/postgres";

const API_BASE = "https://open-api.unisat.io/v3/market/collection/auction";
const PAGE_SIZE = 20; // real, confirmed server-enforced max (exclusiveMaximum 21)

/** Same durable discovery-cursor table/pattern unisat-collection-list-scan.ts
 * uses -- a distinct key so this ranked-art walk and that registry walk
 * advance independently. */
const ART_CURSOR_KEY = "bitcoin-mainnet:collection-art-backfill";

async function readArtStart(): Promise<number> {
  const result = await postgresQuery<{ last_scanned_block: string }>(
    `SELECT last_scanned_block FROM plank_multichain_discovery_cursor WHERE chain_slug = $1`,
    [ART_CURSOR_KEY]
  );
  return result.rows[0] ? Number(result.rows[0].last_scanned_block) : 0;
}

async function writeArtStart(start: number): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_discovery_cursor (chain_slug, last_scanned_block, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (chain_slug) DO UPDATE SET last_scanned_block = EXCLUDED.last_scanned_block, updated_at = NOW()`,
    [ART_CURSOR_KEY, start]
  );
}

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

/**
 * NO MULTI-KEY POOL BUILT FOR UNISAT (doc check performed 2026-08-23, per
 * this session's standing rule -- see opensea-key-pool.ts / alchemy-key-pool.ts
 * / helius-key-pool.ts for the same check on those providers). UniSat's
 * public unisat-dev-docs (github.com/unisat-wallet/unisat-dev-docs) do not
 * document a per-key request quota anywhere in open-api/README.md or the
 * auth-related pages -- the app must issue an authenticated key by email
 * request (contact@unisat.io), and this repo's own existing
 * UNISAT_TESTNET_API_KEY/UNISAT_API_KEY split already treats keys as
 * account/environment-scoped credentials, not independent capacity
 * grants. Absent any documented per-key bucket (the one thing that made
 * pooling worthwhile for OpenSea/Alchemy/Helius, all of which DO
 * genuinely round-robin real bookkeeping even though their capacity is
 * also account-wide), minting several UniSat keys under the same account
 * would only add bookkeeping with no plausible capacity benefit, so this
 * stays single-key. If UniSat ever documents independent per-key
 * capacity, build unisat-key-pool.ts following the exact same pattern.
 */
function requireApiKey(): string {
  const key = process.env.UNISAT_API_KEY;
  if (!key) throw new Error("unisat-collections: UNISAT_API_KEY is not configured");
  return key;
}

async function unisatFetch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = requireApiKey();
  let lastErr = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => "");
    if (res.status === 403 || res.status === 429 || text.includes("rate limit")) {
      lastErr = `${res.status} ${text.slice(0, 120)}`;
      await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      throw new Error(`unisat-collections: ${res.status} ${res.statusText} on ${path} -- ${text.slice(0, 200)}`);
    }
    const envelope = JSON.parse(text) as { code: number | string; msg: string; data: T };
    if (envelope.code !== 0) {
      throw new Error(`unisat-collections: ${path} returned code ${envelope.code} -- ${envelope.msg}`);
    }
    return envelope.data;
  }
  throw new Error(`unisat-collections: rate limited on ${path} -- ${lastErr}`);
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

/**
 * Walk UniSat's ranked list (has icon + name per page of 20) and write
 * exact-id display. Snapshot fetch of /collection_statistic 500s for many
 * ids; the list endpoint is the working art/name source. Never invents.
 *
 * Resumes from a durable cursor in plank_multichain_discovery_cursor (same
 * table/pattern as unisat-collection-list-scan.ts's readStart/writeStart,
 * under its own ART_CURSOR_KEY) so repeated cron/supervisor calls actually
 * advance through the ranked list instead of re-walking the same first
 * `maxPages * PAGE_SIZE` window every invocation. Wraps back to 0 once the
 * list end is reached, so subsequent calls re-refresh from the top rather
 * than stalling forever at the tail.
 */
export async function backfillUnisatCollectionArt(maxPages = 60): Promise<{
  scanned: number;
  named: number;
  imaged: number;
}> {
  let scanned = 0;
  let named = 0;
  let imaged = 0;
  let start = await readArtStart();
  for (let page = 0; page < maxPages; page++) {
    let data: { list: UniSatCollectionEntry[]; total: number };
    try {
      data = await unisatFetch<{ list: UniSatCollectionEntry[]; total: number }>("/collection_statistic_list", {
        start,
        limit: PAGE_SIZE,
        filter: { timeType: "24h" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("rate limited") || msg.includes("403")) break;
      throw e;
    }
    for (const entry of data.list) {
      scanned += 1;
      const id = entry.collectionId;
      if (!id) continue;
      await upsertTrackedCollection({
        chainSlug: "bitcoin-mainnet",
        chainId: null,
        contractAddress: id,
        adapter: "unisat-collections",
      });
      const imageUrl = resolveIconUrl(entry.icon);
      const name = entry.name?.trim() || null;
      if (name || imageUrl) {
        await updateCollectionDisplay("bitcoin-mainnet", id, { name, imageUrl });
        if (name) named += 1;
        if (imageUrl) imaged += 1;
      }
      const floor = entry.floorPrice != null ? satsToScaledString(entry.floorPrice) : null;
      if (floor) {
        await updateCollectionFloorOnly("bitcoin-mainnet", id, {
          floorPriceWei: floor,
          floorPriceCurrency: "BTC",
          floorPriceMarketplace: "unisat",
        }).catch(() => {});
      }
      const supply = entry.total ?? entry.supply ?? null;
      const listed = entry.listed ?? null;
      if (supply != null || listed != null) {
        await updateCollectionSupplyFields("bitcoin-mainnet", id, {
          totalSupply: supply,
          listedCount: listed,
        }).catch(() => {});
      }
      const holders =
        (typeof entry.holders === "number" && entry.holders > 0 && entry.holders) ||
        (typeof entry.uniqueHolders === "number" && entry.uniqueHolders > 0 && entry.uniqueHolders) ||
        null;
      if (holders) {
        await updateHolderCount("bitcoin-mainnet", id, holders).catch(() => {});
      }
    }
    start += PAGE_SIZE;
    if (data.list.length < PAGE_SIZE || start >= data.total) {
      start = 0; // reached the end of the ranked list -- wrap and refresh from the top
      break;
    }
    await new Promise((r) => setTimeout(r, 1_200));
  }
  await writeArtStart(start);
  return { scanned, named, imaged };
}

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
