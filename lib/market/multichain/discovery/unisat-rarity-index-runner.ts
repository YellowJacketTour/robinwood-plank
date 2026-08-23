/**
 * Real per-piece trait/rarity indexing for Bitcoin Ordinals, the same
 * shared generic storage layer (computeGenericRaritySnapshot +
 * replaceForeignRarity) EVM and Solana rarity already use.
 *
 * REAL DATA SOURCE, VERIFIED LIVE 2026-08-20: UniSat's own collection
 * catalog (collection-indexer/collection/list, unisat-collection-list-
 * scan.ts) and the ranked stats endpoint (unisat-collections.ts) carry NO
 * per-item trait data. `auction/list` (the endpoint an earlier pass in
 * this session assumed was the trait source) also has none, confirmed by
 * checking a real tracked inscription's own info payload. The real source
 * is a DIFFERENT endpoint: POST /v3/market/collection/auction/actions --
 * a marketplace ACTIVITY log (list/cancel/sold/updated events), which
 * happens to carry a real `attributes: [{trait_type, value}]` array
 * inline per event. Verified live against Bitcoin Frogs: real traits
 * (Background, Body, Clothing, Mouth, Eyes) came back correctly.
 *
 * HONEST SCOPE, NOT FULL COVERAGE: because this is an activity log, not a
 * collection enumeration, it only carries inscriptions that have actually
 * appeared in marketplace activity (list/sell/cancel/update) -- verified
 * live: Bitcoin Frogs (10,000 real supply) returned `total: 6288` events,
 * not 10,000 unique items, and even 6,288 events likely maps to FEWER
 * unique inscriptions once deduped (the same piece can list/cancel/relist
 * many times). Every real per-item trait discovered this way is real,
 * never fabricated -- but this can NEVER reach 100% coverage the way
 * EVM's OpenSea /nfts pagination or Solana's Helius grouping walk can,
 * because there is no Bitcoin equivalent of "walk every token in the
 * collection" for trait data specifically. `partial` is always true here
 * by construction, not a bug to fix later.
 */
import { computeGenericRaritySnapshot, type GenericRarityInput } from "@/lib/rarity-generic";
import { replaceForeignRarity } from "@/lib/market/multichain/foreign-rarity-store";
import { listTrackedCollections } from "@/lib/market/multichain/store";
import { reserveProviderCapacity, settleProviderCapacity, unisatBackgroundDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";
import { upsertCollectionTokenProjection } from "@/lib/market/multichain/collection-token-store";
import { postgresQuery } from "@/lib/postgres";

const API_BASE = "https://open-api.unisat.io/v3/market/collection/auction/actions";
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // real bound -- 5,000 events is a generous real sample of marketplace activity without paginating a huge collection's full history forever

function apiKey(): string {
  const key = process.env.UNISAT_API_KEY?.trim();
  if (!key) throw new Error("unisat-rarity-index-runner: UNISAT_API_KEY is not configured");
  return key;
}

type UniSatActionEvent = {
  inscriptionId: string;
  collectionItemName?: string | null;
  attributes?: Array<{ trait_type?: string; value?: string }> | null;
};

async function fetchActionsPage(collectionId: string, start: number): Promise<{ list: UniSatActionEvent[]; total: number }> {
  if (await isSourceJailed("unisat")) throw new Error("unisat-rarity-index-runner: source jailed");
  const key = apiKey();
  // This enrichment shares the same durable 1,800-call background window as
  // membership. Membership runs first so an activity-heavy collection can
  // never starve canonical piece discovery.
  const window = unisatBackgroundDayWindow();
  if (!(await reserveProviderCapacity("unisat:default", window))) {
    throw new Error("unisat-rarity-index-runner: durable daily ceiling");
  }
  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ filter: { collectionId }, start, limit: PAGE_SIZE }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`unisat-rarity-index-runner: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { code: number; msg: string; data?: { list: UniSatActionEvent[]; total: number } };
    if (body.code !== 0) throw new Error(`unisat-rarity-index-runner: API error ${body.code} ${body.msg}`);
    return body.data ?? { list: [], total: 0 };
  } finally {
    await settleProviderCapacity("unisat:default", window, 1, true).catch(() => {});
  }
}

export type BitcoinRarityIndexResult = {
  chainSlug: "bitcoin-mainnet";
  collectionId: string;
  tokensIndexed: number;
  eventsWalked: number;
  partial: true;
};

/** Walks real marketplace activity for one collection, deduping by inscriptionId (keeping the first/most-recent attributes seen), and indexes whatever real per-piece traits surface. `partial` is always true -- see this file's own header for why full coverage isn't achievable via this data source. */
export async function indexBitcoinCollectionRarity(collectionId: string): Promise<BitcoinRarityIndexResult> {
  const seen = new Map<string, GenericRarityInput>();
  let start = 0;
  let eventsWalked = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { list, total } = await fetchActionsPage(collectionId, start);
    eventsWalked += list.length;
    for (const event of list) {
      if (seen.has(event.inscriptionId)) continue;
      const traits = (event.attributes ?? [])
        .filter((a) => a.trait_type && a.value != null)
        .map((a) => ({ traitType: a.trait_type!, value: a.value! }));
      if (traits.length === 0) continue; // no real signal for this item -- skip rather than index an empty row
      seen.set(event.inscriptionId, {
        tokenId: event.inscriptionId,
        name: event.collectionItemName ?? null,
        traits,
      });
    }
    start += list.length;
    if (list.length === 0 || start >= total) break;
  }

  const items = [...seen.values()];
  const snapshot = { ...computeGenericRaritySnapshot(items), partial: true as const };
  const traitIndex: Record<string, Record<string, string[]>> = {};
  for (const item of items) {
    for (const t of item.traits) {
      traitIndex[t.traitType] ??= {};
      traitIndex[t.traitType][t.value] ??= [];
      traitIndex[t.traitType][t.value].push(item.tokenId);
    }
  }

  await replaceForeignRarity("bitcoin-mainnet", collectionId, snapshot, traitIndex);
  const observedAt = new Date();
  await upsertCollectionTokenProjection("bitcoin-mainnet", collectionId, {
    tokens: [...snapshot.byTokenId.values()].map((token) => ({
      tokenId: token.tokenId,
      name: token.name,
      imageUrl: token.imageUrl ?? null,
      traits: items.find((item) => item.tokenId === token.tokenId)?.traits ?? [],
      rarityScore: token.score,
      rarityRank: token.rank,
      rarityPercentile: token.percentile,
      rarityTier: token.tier,
    })),
    expectedCount: null,
    partial: true,
    provenance: ["unisat-market-activity", "bespoke-information-content-rarity"],
    sourceObservedAt: observedAt,
  });

  return { chainSlug: "bitcoin-mainnet", collectionId, tokensIndexed: snapshot.byTokenId.size, eventsWalked, partial: true };
}

export type ScaffoldBitcoinResult = {
  totalTracked: number;
  indexed: number;
  skippedFresh: number;
  failed: number;
};

export async function scaffoldAllTrackedBitcoinCollections(opts?: {
  force?: boolean;
  freshDays?: number;
  delayMs?: number;
  limit?: number;
  onProgress?: (line: string) => void;
}): Promise<ScaffoldBitcoinResult> {
  const force = opts?.force ?? false;
  const freshDays = opts?.freshDays ?? 7;
  const delayMs = opts?.delayMs ?? 1000;
  // A collection can consume up to MAX_PAGES requests.  An unbounded daily
  // walk therefore cannot respect the provider ceiling; subsequent passes
  // resume from the durable rarity timestamps.
  const limit = opts?.limit ?? 25;
  const log = opts?.onProgress ?? (() => {});

  const all = await listTrackedCollections();
  const candidates = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     LEFT JOIN plank_foreign_rarity_collections r
       ON r.chain_slug = c.chain_slug AND lower(r.collection_slug) = lower(c.contract_address)
     WHERE c.chain_slug = 'bitcoin-mainnet'
       AND ($1::boolean OR r.indexed_at IS NULL OR r.indexed_at < NOW() - ($2::text || ' days')::interval)
     ORDER BY (r.indexed_at IS NULL) DESC,
       (COALESCE(s.listed_count, 0) > 0 OR s.floor_price_wei IS NOT NULL OR s.volume_24h_wei IS NOT NULL) DESC,
       (c.name IS NOT NULL AND c.image_url IS NOT NULL) DESC,
       r.indexed_at ASC NULLS FIRST,
       c.id
     LIMIT $3`,
    [force, freshDays, Math.max(1, Math.trunc(limit))]
  );
  const bitcoin = candidates.rows.map((row) => ({ contractAddress: row.contract_address }));

  let indexed = 0;
  const skippedFresh = 0;
  let failed = 0;
  let attempted = 0;

  for (const c of bitcoin) {
    if (attempted >= limit) break;
    attempted += 1;
    try {
      const result = await indexBitcoinCollectionRarity(c.contractAddress);
      log(`indexed ${c.contractAddress} (bitcoin-mainnet): ${result.tokensIndexed} tokens from ${result.eventsWalked} events (PARTIAL -- activity-log coverage only)`);
      indexed += 1;
    } catch (error) {
      log(`FAILED ${c.contractAddress} (bitcoin-mainnet): ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }

    await sleep(delayMs);
  }

  return { totalTracked: all.length, indexed, skippedFresh, failed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
