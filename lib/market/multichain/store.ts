/**
 * Storage layer for deploy/inmotion/postgres/migrations/013_multichain_collections.sql.
 * See that migration for why this is a separate, current-state cache rather
 * than an extension of lib/market/chain-events.ts's append-only ledger.
 */
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import type { CollectionSnapshot, TrackedCollection } from "@/lib/market/multichain/types";
import { isNonEvmChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

export function hasMultichainStore(): boolean {
  return hasPostgresConfig();
}

/**
 * Real bug found live 2026-08-20: every write path here unconditionally
 * lowercased contractAddress before storing/matching it. That's correct
 * for EVM hex addresses (case-insensitive, sometimes checksum-cased on
 * input) but WRONG for Solana pubkeys and Bitcoin Ordinals slugs/
 * collectionIds -- Solana's base58 addresses are case-sensitive, so
 * lowercasing one turns it into a different, almost always invalid
 * pubkey. Confirmed live: every "solana-mainnet" row registered before
 * this fix had a corrupted, unresolvable address (getAsset returning a
 * real "Pubkey Validation Err" for -- not a rare edge case, effectively
 * all of them, since discovery always ran through this same lowercasing
 * write path). EVM chains keep lowercasing (matches this app's own
 * existing 0x-prefixed address convention everywhere else); every
 * non-EVM chain now preserves the exact case it was given.
 */
function normalizeContractAddress(chainSlug: string, contractAddress: string): string {
  return isNonEvmChainSlug(chainSlug) ? contractAddress : contractAddress.toLowerCase();
}

/**
 * Real bug found live 2026-08-23: three non-EVM discovery adapters
 * (ordinalswallet-collection-scan.ts, unisat-collection-list-scan.ts,
 * the magiceden-solana discovery path) each register a collection under
 * whatever slug string their own upstream API happens to hand back for
 * the SAME real collection -- confirmed live for 37 groups / 74 rows,
 * e.g. Bitcoin Ordinals "bitcoin-shrooms" vs "bitcoinshrooms" (both
 * "Bitcoin Shrooms", same creator site, upstream just registered it
 * twice under different slugs). A naive fuzzy-slug merge is NOT safe on
 * its own: the same sweep found ~8-10 pairs that fuzzy-match on slug but
 * are genuinely different collections (e.g. "foxy" -> "The Foxy Gang" vs
 * "Foxygon", "sats" -> "SATS" vs "Satributes - Contributors",
 * "bitcoinpandas" -> "Bitcoin Pandas" vs "Genesis Panz") plus hundreds of
 * BRC-20 ticker rows that only collide once punctuation is stripped. So
 * this is gated on BOTH a fuzzy-slug match AND a real name match, scoped
 * to the same chain+adapter -- EVM chains are untouched (their
 * case-insensitive contract_address already prevents this duplicate
 * class entirely, see normalizeContractAddress above).
 */
function normalizeSlugForCollision(slug: string): string {
  return slug.toLowerCase().replace(/[-_\s]+/g, "");
}

function normalizeNameForCollision(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
}

async function resolveCanonicalContractAddress(input: {
  chainSlug: string;
  contractAddress: string;
  adapter: string;
  nameHint?: string | null;
}): Promise<string> {
  const address = normalizeContractAddress(input.chainSlug, input.contractAddress);
  if (!isNonEvmChainSlug(input.chainSlug)) return address;
  const nameHint = input.nameHint?.trim();
  if (!nameHint) return address;
  const targetSlugKey = normalizeSlugForCollision(address);
  const targetNameKey = normalizeNameForCollision(nameHint);
  if (!targetSlugKey || !targetNameKey) return address;
  const result = await postgresQuery<{ contract_address: string; name: string | null }>(
    `SELECT contract_address, name FROM plank_multichain_collections
     WHERE chain_slug = $1 AND adapter = $2 AND contract_address <> $3 AND name IS NOT NULL`,
    [input.chainSlug, input.adapter, address]
  );
  for (const row of result.rows) {
    if (normalizeSlugForCollision(row.contract_address) !== targetSlugKey) continue;
    if (!row.name || normalizeNameForCollision(row.name) !== targetNameKey) continue;
    // Same chain+adapter, fuzzy-matching slug, exact-matching normalized
    // name: converge onto the existing row's address instead of creating
    // a sibling duplicate (SELECT has no explicit ORDER BY, but there's
    // only ever one such row per real collection once this guard has run).
    return row.contract_address;
  }
  return address;
}

type CollectionRow = {
  id: number;
  chain_slug: string;
  chain_id: string | null;
  contract_address: string;
  adapter: string;
  name: string | null;
  image_url: string | null;
  external_url: string | null;
  is_vault_backed: boolean;
  creator_handle: string | null;
  creator_address: string | null;
  creator_ens: string | null;
};

function rowToCollection(row: CollectionRow): TrackedCollection {
  return {
    id: row.id,
    chainSlug: row.chain_slug,
    chainId: row.chain_id == null ? null : Number(row.chain_id),
    contractAddress: row.contract_address,
    adapter: row.adapter,
    name: row.name,
    imageUrl: row.image_url,
    externalUrl: row.external_url,
    isVaultBacked: row.is_vault_backed,
    creatorHandle: row.creator_handle,
    creatorAddress: row.creator_address,
    creatorEns: row.creator_ens,
  };
}

/** Every collection registered for multichain sync. */
export async function listTrackedCollections(): Promise<TrackedCollection[]> {
  const result = await postgresQuery<CollectionRow>(
    `SELECT id, chain_slug, chain_id, contract_address, adapter, name, image_url, external_url, is_vault_backed, creator_handle, creator_address
     FROM plank_multichain_collections
     ORDER BY chain_slug, contract_address`
  );
  return result.rows.map(rowToCollection);
}

/**
 * The real fix for a real bug found live 2026-08-20: runMultichainSync used
 * to call listTrackedCollections() unbounded, in fixed chain_slug order,
 * with real per-adapter pacing delays -- harmless when this app tracked a
 * few hundred collections, but this session's own discovery work grew the
 * index past 16,000 rows (44,000+ on Solana alone), and chain_slug order
 * means "solana-mainnet" sorts after avax/base/bitcoin/bnb/eth/opt/polygon/
 * robinhood -- confirmed live: every one of Solana's 44,773 registered
 * rows had ZERO snapshot rows at all (not synced, not even attempted), the
 * sync loop was structurally never reaching it in one bounded pass.
 *
 * The real fix: order by staleness (oldest-synced-or-never-synced first)
 * and let the caller bound how many rows one call processes. A row that
 * gets synced has its synced_at set to NOW(), pushing it to the back of
 * this same query's own ordering -- no separate cursor needed, the queue
 * is self-maintaining. Every chain now gets real, continuous, fair
 * progress instead of the alphabetically-later ones starving forever.
 */
export async function listCollectionsForSync(
  limit: number,
  opts?: { skipAdapters?: string[]; chainSlug?: string }
): Promise<TrackedCollection[]> {
  const skip = opts?.skipAdapters?.filter(Boolean) ?? [];
  const chain = opts?.chainSlug?.trim();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (skip.length > 0) {
    params.push(skip);
    clauses.push(`c.adapter <> ALL($${params.length}::text[])`);
  }
  if (chain) {
    params.push(chain);
    clauses.push(`c.chain_slug = $${params.length}`);
  }
  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await postgresQuery<CollectionRow>(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url, c.is_vault_backed, c.creator_handle, c.creator_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     ${where}
     -- Real fix, 2026-08-25 ("most frequented collections being handled
     -- extremely efficiently"): this queue used to be pure staleness
     -- (oldest-synced-first) with zero regard for real activity -- a dead,
     -- zero-volume collection got the exact same background cadence as a
     -- top-100-by-sales one. sales_24h (a plain integer, real and already
     -- chain-agnostic-comparable, unlike volume_24h_wei's native-unit
     -- mismatch across chains) backdates a collection's EFFECTIVE
     -- staleness by its own real recent activity, so a busy collection
     -- looks more "overdue" and gets synced more often -- while every
     -- collection's real synced_at clock still advances normally
     -- underneath, so nothing is ever truly starved, only synced less
     -- often. Same self-maintaining-queue design as before, just weighted.
     ORDER BY (COALESCE(s.synced_at, 'epoch'::timestamptz) - (LEAST(COALESCE(s.sales_24h, 0), 500) * INTERVAL '1 minute')) ASC
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map(rowToCollection);
}

/**
 * One tracked collection by its real key -- targeted single-row lookup,
 * same reasoning as getCollectionSupplyStats below (avoid
 * listTrackedCollections' full 6000+-row scan when the caller only needs
 * one). Used by the Marketplank-native foreign-chain listing route to
 * confirm a collection is real/tracked before accepting a signed order
 * against it.
 */
export async function getTrackedCollection(chainSlug: string, contractAddress: string): Promise<TrackedCollection | null> {
  const result = await postgresQuery<CollectionRow>(
    `SELECT id, chain_slug, chain_id, contract_address, adapter, name, image_url, external_url, is_vault_backed, creator_handle, creator_address, creator_ens
     FROM plank_multichain_collections
     WHERE chain_slug = $1 AND contract_address = $2
     LIMIT 1`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const row = result.rows[0];
  return row ? rowToCollection(row) : null;
}

/**
 * Targeted lookup for the creator-entity-linking search expansion (see
 * lib/market/multichain/creator-links.ts for the matching/confidence logic
 * this feeds -- this function only fetches candidates, it does not decide
 * who counts as "the same creator"). Three indexed OR'd equality checks plus
 * one bounded ILIKE for the "by <creator>" name-byline signal, each scoped
 * to a signal the target row actually has -- never a full-table scan, and
 * never invoked unless the search's matched collection carries at least one
 * real creator signal.
 */
export async function findCollectionsByCreatorSignals(input: {
  creatorAddress: string | null;
  creatorHandle: string | null;
  creatorEns: string | null;
  nameByline: string | null;
  excludeChainSlug: string;
  excludeContractAddress: string;
  limit?: number;
}): Promise<Array<{ chainSlug: string; contractAddress: string; name: string | null; creatorAddress: string | null; creatorHandle: string | null; creatorEns: string | null }>> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.creatorAddress) { params.push(input.creatorAddress); clauses.push(`lower(creator_address) = lower($${params.length})`); }
  if (input.creatorHandle) { params.push(input.creatorHandle); clauses.push(`lower(creator_handle) = lower($${params.length})`); }
  if (input.creatorEns) { params.push(input.creatorEns); clauses.push(`lower(creator_ens) = lower($${params.length})`); }
  if (input.nameByline) { params.push(`%by ${input.nameByline}`); clauses.push(`name ILIKE $${params.length}`); }
  if (!clauses.length) return [];
  params.push(input.excludeChainSlug, input.excludeContractAddress);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 12), 1), 25);
  params.push(limit);
  const result = await postgresQuery<{ chain_slug: string; contract_address: string; name: string | null; creator_address: string | null; creator_handle: string | null; creator_ens: string | null }>(
    `SELECT chain_slug, contract_address, name, creator_address, creator_handle, creator_ens
     FROM plank_multichain_collections
     WHERE (${clauses.join(" OR ")})
       AND NOT (chain_slug = $${params.length - 2} AND contract_address = $${params.length - 1})
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    chainSlug: row.chain_slug, contractAddress: row.contract_address, name: row.name,
    creatorAddress: row.creator_address, creatorHandle: row.creator_handle, creatorEns: row.creator_ens,
  }));
}

/**
 * Register a collection for sync, or update its adapter/vault-backed flag if
 * it already exists. Idempotent by (chain_slug, contract_address) — safe to
 * call from a seed script on every deploy without duplicating rows.
 */
export async function upsertTrackedCollection(input: {
  chainSlug: string;
  chainId: number | null;
  contractAddress: string;
  adapter: string;
  isVaultBacked?: boolean;
  /**
   * Optional human-readable name from the same discovery response the
   * contractAddress came from. Non-EVM only: used to gate the fuzzy-slug
   * collision guard above (resolveCanonicalContractAddress) so a second
   * discovery pass under a slightly different slug string converges onto
   * an existing row instead of registering a duplicate. Omit it and this
   * call behaves exactly as before (no dedup attempted).
   */
  nameHint?: string | null;
}): Promise<number> {
  // Real bug found live 2026-08-23: unconditionally reassigning `adapter`
  // on every conflict let a second discovery source with the same
  // (chain_slug, contract_address) string silently steal ownership of a
  // row an earlier source already registered -- confirmed live for
  // Bitcoin Ordinals, where UniSat's own collectionId and OrdinalsWallet's
  // slug are frequently the identical human-readable string (e.g.
  // "bitcoin-frogs"): running the OrdinalsWallet discovery scan flipped
  // ~1,446 rows from "unisat-collections" to "ordinalswallet-ordinals".
  // First-writer-wins now: a row keeps its original adapter across
  // conflicts unless re-upserted under that SAME adapter (the normal,
  // intended re-confirm-my-own-row case every discovery scan already
  // does on every pass). This is exactly the behavior every Bitcoin
  // discovery scan's own header comment (ordiscan-collection-scan.ts,
  // ordinalswallet-collection-scan.ts) already documented as the
  // *intended* outcome of a same-string collision -- the SQL just didn't
  // implement it yet.
  const canonicalAddress = await resolveCanonicalContractAddress({
    chainSlug: input.chainSlug,
    contractAddress: input.contractAddress,
    adapter: input.adapter,
    nameHint: input.nameHint,
  });
  const result = await postgresQuery<{ id: number }>(
    `INSERT INTO plank_multichain_collections (chain_slug, chain_id, contract_address, adapter, is_vault_backed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chain_slug, contract_address)
     DO UPDATE SET
       adapter = plank_multichain_collections.adapter,
       is_vault_backed = EXCLUDED.is_vault_backed
     RETURNING id`,
    [input.chainSlug, input.chainId, canonicalAddress, input.adapter, input.isVaultBacked ?? false]
  );
  return result.rows[0].id;
}

/**
 * Overwrite a collection's display name/image with a freshly-fetched real
 * value, keyed by (chainSlug, contractAddress) rather than internal id --
 * for rarity-index-runner.ts's real-OpenSea-art backfill. The COALESCE is
 * only a null-guard for THIS call (never overwrite with an absent value),
 * not a "keep the old one" guard -- callers only pass a real, freshly-
 * fetched OpenSea value, so a dead img.reservoir.tools URL already stored
 * always gets replaced, unlike writeSnapshot's own fill-if-empty COALESCE.
 */
export async function updateCollectionDisplay(
  chainSlug: string,
  contractAddress: string,
  display: {
    name: string | null;
    imageUrl: string | null;
    creatorHandle?: string | null;
    creatorAddress?: string | null;
    creatorEns?: string | null;
  }
): Promise<void> {
  await postgresQuery(
    `UPDATE plank_multichain_collections
     SET name = COALESCE($3, name), image_url = COALESCE($4, image_url),
         creator_handle = COALESCE($5, creator_handle), creator_address = COALESCE($6, creator_address),
         creator_ens = COALESCE($7, creator_ens)
     WHERE chain_slug = $1 AND contract_address = $2`,
    [
      chainSlug,
      normalizeContractAddress(chainSlug, contractAddress),
      display.name,
      display.imageUrl,
      display.creatorHandle ?? null,
      display.creatorAddress ?? null,
      display.creatorEns ?? null,
    ]
  );
}

/**
 * Real 24h/7d/30d volume/sales (OpenSea /collections/{slug}/stats,
 * confirmed live -- all three windows come out of the same response) plus
 * a real floor % change computed from THIS app's own prior observation --
 * OpenSea's stats endpoint has no floor-change field at all, so
 * previous_floor_price_wei is this app's own history, not a third-party
 * figure repackaged as if it were.
 *
 * volume7dWei/sales7d/volume30dWei/sales30d default to null (not COALESCE'd
 * against the prior row) when omitted, matching volume24hWei/sales24h's own
 * existing overwrite-on-each-pass semantics -- a caller that doesn't have
 * multi-window data yet (e.g. an older code path) simply clears it rather
 * than leaving a stale figure standing in for a fresh one.
 */
export async function updateCollectionMarketStats(
  chainSlug: string,
  contractAddress: string,
  stats: {
    volume24hWei: string | null;
    sales24h: number | null;
    currentFloorPriceWei: string | null;
    volume7dWei?: string | null;
    sales7d?: number | null;
    volume30dWei?: string | null;
    sales30d?: number | null;
    floorChangePct?: number | null;
  }
): Promise<void> {
  const collection = await postgresQuery<{ id: number }>(
    `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const id = collection.rows[0]?.id;
  if (!id) return;
  await postgresQuery(
    `UPDATE plank_multichain_snapshots
     SET volume_24h_wei = $2, sales_24h = $3,
         volume_7d_wei = $4, sales_7d = $5,
         volume_30d_wei = $6, sales_30d = $7,
         floor_change_pct = COALESCE($8, floor_change_pct),
         synced_at = NOW()
     WHERE collection_id = $1`,
    [
      id,
      nonzeroWei(stats.volume24hWei),
      nonzeroCount(stats.sales24h),
      nonzeroWei(stats.volume7dWei ?? null),
      nonzeroCount(stats.sales7d ?? null),
      nonzeroWei(stats.volume30dWei ?? null),
      nonzeroCount(stats.sales30d ?? null),
      stats.floorChangePct === 0 ? null : (stats.floorChangePct ?? null),
    ]
  );
}

function nonzeroWei(v: string | null | undefined): string | null {
  if (v == null || v === "" || v === "0") return null;
  try {
    return BigInt(v) > 0n ? v : null;
  } catch {
    return null;
  }
}
function nonzeroCount(n: number | null | undefined): number | null {
  if (n == null || n === 0) return null;
  return n;
}

/**
 * Stored "0" was written when OpenSea/CG returned a real empty interval or
 * Alchemy returned a zero floor — the hub then showed Vol 0 / $0.00 / 0.0%.
 * Unknown is NULL (dash). Self-heal: scrub zeros, leave positive values.
 */
export async function sanitizeUnknownZeros(): Promise<{ floors: number; volumes: number; sales: number; changes: number }> {
  const floors = await postgresQuery(
    `UPDATE plank_multichain_snapshots SET floor_price_wei = NULL, floor_price_currency = NULL, floor_price_marketplace = NULL
     WHERE floor_price_wei = '0'`
  );
  const volumes = await postgresQuery(
    `UPDATE plank_multichain_snapshots SET volume_24h_wei = NULL WHERE volume_24h_wei = '0'`
  );
  const sales = await postgresQuery(
    `UPDATE plank_multichain_snapshots SET sales_24h = NULL WHERE sales_24h = 0`
  );
  const changes = await postgresQuery(
    `UPDATE plank_multichain_snapshots SET floor_change_pct = NULL WHERE floor_change_pct = 0`
  );
  return {
    floors: floors.rowCount ?? 0,
    volumes: volumes.rowCount ?? 0,
    sales: sales.rowCount ?? 0,
    changes: changes.rowCount ?? 0,
  };
}

/**
 * Real 24h volume/sales for every EVM collection this app tracks, computed
 * from `plank_seaport_fills` (migration 023) -- this app's own first-party,
 * self-hosted on-chain fill index (watches Seaport's OrderFulfilled event
 * directly, no third party involved). Closes a real gap flagged live
 * 2026-08-20: that table has been populated by seaport-fill-indexer.ts
 * this whole time but was never queried by anything, so every EVM
 * collection's 24h Change/Volume/Sales stayed empty unless it also
 * happened to have a resolvable OpenSea slug (rarity-index-runner.ts's
 * OpenSea-stats path, the only other writer of these same columns).
 * Covers Robinhood Chain's own community collections too -- they have no
 * OpenSea presence at all (private L3), so this is their ONLY possible
 * source of real volume data.
 *
 * ONE BATCHED SQL AGGREGATION, NOT N PER-COLLECTION QUERIES -- every
 * collection on a chain gets its real 24h sum/count in a single query,
 * matching getTopByActivity's own "our own ranking, not a third-party
 * endpoint" pattern one file up. Collections with zero real fills in the
 * window are simply absent from the aggregation result and correctly stay
 * at their prior value (never zeroed out -- a real zero-volume day and
 * "we haven't observed anything yet" must not be conflated).
 */
export async function updateEvmVolumeFromSeaportFills(chainSlug: string): Promise<{ updated: number }> {
  const result = await postgresQuery<{ contract_address: string; volume_wei: string; sales: string }>(
    `SELECT LOWER(nft_contract) AS contract_address, SUM(price_wei)::text AS volume_wei, COUNT(*)::text AS sales
     FROM plank_seaport_fills
     WHERE chain_slug = $1
       AND nft_contract IS NOT NULL
       AND price_wei IS NOT NULL
       -- Snapshot volume_24h_wei is denominated in the chain's native
       -- 18-decimal unit. ERC-20 atomic values (often 6 decimals) cannot
       -- be added to it. Those remain durably preserved in payment_legs
       -- for USD-normalized aggregation; excluding them here is honest
       -- and prevents corrupt headline volume until that projection runs.
       AND currency_token IS NULL
       AND block_timestamp > NOW() - INTERVAL '24 hours'
     GROUP BY LOWER(nft_contract)`,
    [chainSlug]
  );
  let updated = 0;
  for (const row of result.rows) {
    await updateCollectionMarketStats(chainSlug, row.contract_address, {
      volume24hWei: row.volume_wei,
      sales24h: Number(row.sales),
      currentFloorPriceWei: null,
    });
    updated += 1;
  }
  return { updated };
}

/**
 * Real, floor-ONLY write for a secondary stats source (e.g. OpenSea's
 * per-collection /stats endpoint, opensea-stats.ts) that doesn't have
 * totalSupply/listedCount to report -- unlike writeSnapshot below, whose
 * total_supply/listed_count columns are a PLAIN OVERWRITE (EXCLUDED.*,
 * no COALESCE) specifically because a real primary adapter (Alchemy)
 * reports both together every time. Calling writeSnapshot with only a
 * floor and null supply/listed would silently wipe out real values a
 * prior Alchemy sync already recorded -- this function exists so a
 * floor-only source can never do that: total_supply/listed_count/
 * holder_count all COALESCE against whatever is already there.
 */
export async function updateCollectionFloorOnly(
  chainSlug: string,
  contractAddress: string,
  floor: { floorPriceWei: string | null; floorPriceCurrency: string | null; floorPriceMarketplace: string | null }
): Promise<void> {
  const collection = await postgresQuery<{ id: number }>(
    `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const id = collection.rows[0]?.id;
  if (!id || nonzeroWei(floor.floorPriceWei) == null) return;
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots
       (collection_id, floor_price_wei, floor_price_currency, floor_price_marketplace, total_supply, listed_count, holder_count, synced_at, sync_error)
     VALUES ($1, $2, $3, $4, NULL, NULL, NULL, NOW(), NULL)
     ON CONFLICT (collection_id) DO UPDATE SET
       floor_price_wei = EXCLUDED.floor_price_wei,
       floor_price_currency = EXCLUDED.floor_price_currency,
       floor_price_marketplace = EXCLUDED.floor_price_marketplace,
       total_supply = COALESCE(plank_multichain_snapshots.total_supply, EXCLUDED.total_supply),
       listed_count = COALESCE(plank_multichain_snapshots.listed_count, EXCLUDED.listed_count),
       holder_count = COALESCE(plank_multichain_snapshots.holder_count, EXCLUDED.holder_count),
       previous_floor_price_wei = CASE
         WHEN EXCLUDED.floor_price_wei IS NOT NULL
          AND plank_multichain_snapshots.floor_price_wei IS NOT NULL
          AND EXCLUDED.floor_price_wei IS DISTINCT FROM plank_multichain_snapshots.floor_price_wei
          AND plank_multichain_snapshots.synced_at < NOW() - INTERVAL '20 hours'
         THEN plank_multichain_snapshots.floor_price_wei
         ELSE plank_multichain_snapshots.previous_floor_price_wei
       END,
       synced_at = NOW(),
       sync_error = NULL`,
    [id, floor.floorPriceWei, floor.floorPriceCurrency, floor.floorPriceMarketplace]
  );
  await recordFloorObservation(chainSlug, contractAddress, {
    priceAtomic: floor.floorPriceWei,
    currency: floor.floorPriceCurrency,
    marketplace: floor.floorPriceMarketplace,
    listedCount: null,
    source: "collection-floor-adapter",
  });
}

export type FloorChangeObservation = {
  currentPriceAtomic: string;
  comparisonPriceAtomic: string;
  currentObservedAt: string;
  comparisonObservedAt: string;
  changePct: number;
};

/** Persist an exact executable floor without confusing it with a sale price. */
export async function recordFloorObservation(
  chainSlug: string,
  contractAddress: string,
  observation: {
    priceAtomic: string | null;
    currency: string | null;
    marketplace: string | null;
    listedCount: number | null;
    source: string;
  }
): Promise<void> {
  const price = nonzeroWei(observation.priceAtomic);
  if (!price || !observation.currency || !observation.marketplace) return;
  const result = await postgresQuery<{ id: number }>(
    `INSERT INTO plank_collection_floor_observations
       (collection_id, price_atomic, currency, marketplace, listed_count, source)
     SELECT id, $3, $4, $5, $6, $7
     FROM plank_multichain_collections
     WHERE chain_slug = $1 AND contract_address = $2
     ON CONFLICT (collection_id, marketplace, observation_bucket) DO UPDATE SET
       price_atomic = EXCLUDED.price_atomic,
       currency = EXCLUDED.currency,
       listed_count = EXCLUDED.listed_count,
       source = EXCLUDED.source,
       observed_at = NOW()
     RETURNING id`,
    [
      chainSlug,
      normalizeContractAddress(chainSlug, contractAddress),
      price,
      observation.currency,
      observation.marketplace,
      observation.listedCount,
      observation.source,
    ]
  );
  if (result.rowCount !== 1) {
    throw new Error(
      `Cannot record floor observation for untracked collection ${chainSlug}:${contractAddress}.`
    );
  }
}

/**
 * Compare the latest observation with the closest observation at or before
 * 24h ago. Returns null until the system has genuinely observed both ends.
 */
export async function getObservedFloorChange24h(
  chainSlug: string,
  contractAddress: string,
  marketplace?: string
): Promise<FloorChangeObservation | null> {
  const result = await postgresQuery<{
    current_price: string;
    comparison_price: string;
    current_at: string;
    comparison_at: string;
  }>(
    `WITH target AS (
       SELECT id FROM plank_multichain_collections
       WHERE chain_slug = $1 AND contract_address = $2
     ), current_floor AS (
       SELECT price_atomic, observed_at
       FROM plank_collection_floor_observations
       WHERE collection_id = (SELECT id FROM target)
         AND ($3::text IS NULL OR marketplace = $3)
       ORDER BY observed_at DESC LIMIT 1
     ), comparison_floor AS (
       SELECT price_atomic, observed_at
       FROM plank_collection_floor_observations
       WHERE collection_id = (SELECT id FROM target)
         AND ($3::text IS NULL OR marketplace = $3)
         AND observed_at <= NOW() - INTERVAL '24 hours'
       ORDER BY observed_at DESC LIMIT 1
     )
     SELECT c.price_atomic::text AS current_price,
            p.price_atomic::text AS comparison_price,
            c.observed_at::text AS current_at,
            p.observed_at::text AS comparison_at
     FROM current_floor c CROSS JOIN comparison_floor p`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress), marketplace ?? null]
  );
  const row = result.rows[0];
  if (!row) return null;
  const current = BigInt(row.current_price);
  const comparison = BigInt(row.comparison_price);
  if (comparison <= 0n) return null;
  return {
    currentPriceAtomic: row.current_price,
    comparisonPriceAtomic: row.comparison_price,
    currentObservedAt: row.current_at,
    comparisonObservedAt: row.comparison_at,
    changePct: (Number(current - comparison) / Number(comparison)) * 100,
  };
}

/** Write a real listed-count and/or total-supply without clobbering the other, or floor. 0 is a real count (nothing listed), null means skip that column. */
export async function updateCollectionSupplyFields(
  chainSlug: string,
  contractAddress: string,
  supply: { listedCount: number | null; totalSupply: number | null; holderCount?: number | null }
): Promise<void> {
  if (supply.listedCount == null && supply.totalSupply == null && supply.holderCount == null) return;
  const collection = await postgresQuery<{ id: number }>(
    `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const id = collection.rows[0]?.id;
  if (!id) return;
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots
       (collection_id, floor_price_wei, floor_price_currency, floor_price_marketplace, total_supply, listed_count, holder_count, synced_at, sync_error)
     VALUES ($1, NULL, NULL, NULL, $2, $3, $4, NOW(), NULL)
     ON CONFLICT (collection_id) DO UPDATE SET
       total_supply = COALESCE(EXCLUDED.total_supply, plank_multichain_snapshots.total_supply),
       listed_count = COALESCE(EXCLUDED.listed_count, plank_multichain_snapshots.listed_count),
       holder_count = COALESCE(EXCLUDED.holder_count, plank_multichain_snapshots.holder_count),
       synced_at = NOW()`,
    [id, supply.totalSupply, supply.listedCount, supply.holderCount ?? null]
  );
}

/** Write a fresh snapshot for a collection, and refresh its display fields. */
export async function writeSnapshot(
  collectionId: number,
  snapshot: CollectionSnapshot
): Promise<void> {
  await postgresQuery(
    `UPDATE plank_multichain_collections
     SET name = COALESCE($2, name), image_url = COALESCE($3, image_url), external_url = COALESCE($4, external_url),
         creator_address = COALESCE($5, creator_address), creator_handle = COALESCE($6, creator_handle)
     WHERE id = $1`,
    [
      collectionId,
      snapshot.name,
      snapshot.imageUrl,
      snapshot.externalUrl,
      snapshot.creatorAddress ?? null,
      snapshot.creatorHandle ?? null,
    ]
  );
  // holder_count uses COALESCE (like creator_address/creator_handle above),
  // not a plain overwrite like floor_price/total_supply/listed_count -- an
  // adapter that can't provide a holder count (or the on-demand-only path
  // simply not having been asked for one this run, see fetchSnapshotsBatch's
  // reasoning in alchemy-nft.ts) passes null, and that null must never
  // clobber a real value a prior single-collection fetch already recorded.
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots
       (collection_id, floor_price_wei, floor_price_currency, floor_price_marketplace, total_supply, listed_count, holder_count, synced_at, sync_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NULL)
     ON CONFLICT (collection_id) DO UPDATE SET
       floor_price_wei = COALESCE(EXCLUDED.floor_price_wei, plank_multichain_snapshots.floor_price_wei),
       floor_price_currency = COALESCE(EXCLUDED.floor_price_currency, plank_multichain_snapshots.floor_price_currency),
       floor_price_marketplace = COALESCE(EXCLUDED.floor_price_marketplace, plank_multichain_snapshots.floor_price_marketplace),
       total_supply = COALESCE(EXCLUDED.total_supply, plank_multichain_snapshots.total_supply),
       listed_count = COALESCE(EXCLUDED.listed_count, plank_multichain_snapshots.listed_count),
       holder_count = COALESCE(EXCLUDED.holder_count, plank_multichain_snapshots.holder_count),
       previous_floor_price_wei = CASE
         WHEN EXCLUDED.floor_price_wei IS NOT NULL
          AND plank_multichain_snapshots.floor_price_wei IS NOT NULL
          AND EXCLUDED.floor_price_wei IS DISTINCT FROM plank_multichain_snapshots.floor_price_wei
          AND plank_multichain_snapshots.synced_at < NOW() - INTERVAL '20 hours'
         THEN plank_multichain_snapshots.floor_price_wei
         ELSE plank_multichain_snapshots.previous_floor_price_wei
       END,
       synced_at = NOW(),
       sync_error = NULL`,
    [
      collectionId,
      nonzeroWei(snapshot.floorPriceWei),
      snapshot.floorPriceCurrency,
      snapshot.floorPriceMarketplace,
      snapshot.totalSupply,
      snapshot.listedCount,
      snapshot.holderCount ?? null,
    ]
  );
}

/** Record that a sync attempt failed, without clobbering the last-good snapshot's price data. */
export async function writeSnapshotError(collectionId: number, error: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots (collection_id, synced_at, sync_error)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (collection_id) DO UPDATE SET synced_at = NOW(), sync_error = EXCLUDED.sync_error`,
    [collectionId, error]
  );
}

export type CollectionWithSnapshot = TrackedCollection & {
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  floorPriceMarketplace: string | null;
  totalSupply: number | null;
  listedCount: number | null;
  syncedAt: string | null;
  syncError: string | null;
  volume24hWei: string | null;
  sales24h: number | null;
  /** Real OpenSea 7d/30d volume/sales -- same response as the 24h fields (see updateCollectionMarketStats), never a fabricated multi-window figure derived from a single data point. Null until a collection has been through the OpenSea stats pass at least once. */
  volume7dWei: string | null;
  sales7d: number | null;
  volume30dWei: string | null;
  sales30d: number | null;
  previousFloorPriceWei: string | null;
  /** Real distinct-owner count (Alchemy getOwnersForContract, EVM chains only) -- null, never a fabricated 0. */
  holderCount: number | null;
  /** Real 24h floor change % when a source reports it (CoinGecko) or when previous_floor is a ~24h-old observation. */
  floorChangePct: number | null;
};

/** Everything the read API needs in one query — collections joined to their latest snapshot. */
export async function listCollectionsWithSnapshots(): Promise<CollectionWithSnapshot[]> {
  const result = await postgresQuery<
    CollectionRow & {
      floor_price_wei: string | null;
      floor_price_currency: string | null;
      floor_price_marketplace: string | null;
      total_supply: string | null;
      listed_count: number | null;
      synced_at: string | null;
      sync_error: string | null;
      volume_24h_wei: string | null;
      sales_24h: number | null;
      volume_7d_wei: string | null;
      sales_7d: number | null;
      volume_30d_wei: string | null;
      sales_30d: number | null;
      previous_floor_price_wei: string | null;
      holder_count: number | null;
      floor_change_pct: number | null;
    }
  >(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url, c.is_vault_backed,
            c.creator_handle, c.creator_address, c.creator_ens,
            s.floor_price_wei, s.floor_price_currency, s.floor_price_marketplace, s.total_supply, s.listed_count, s.synced_at, s.sync_error,
            s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d, s.volume_30d_wei, s.sales_30d, s.previous_floor_price_wei,
            s.holder_count, s.floor_change_pct
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     ORDER BY c.chain_slug, c.contract_address`
  );
  return result.rows.map((row) => ({
    ...rowToCollection(row),
    floorPriceWei: row.floor_price_wei,
    floorPriceCurrency: row.floor_price_currency,
    floorPriceMarketplace: row.floor_price_marketplace,
    totalSupply: row.total_supply == null ? null : Number(row.total_supply),
    listedCount: row.listed_count,
    syncedAt: row.synced_at,
    syncError: row.sync_error,
    volume24hWei: row.volume_24h_wei,
    sales24h: row.sales_24h,
    volume7dWei: row.volume_7d_wei,
    sales7d: row.sales_7d,
    volume30dWei: row.volume_30d_wei,
    sales30d: row.sales_30d,
    previousFloorPriceWei: row.previous_floor_price_wei,
    holderCount: row.holder_count,
    floorChangePct: row.floor_change_pct,
  }));
}

/**
 * Bounded, ranked window over the full catalog for the Global Market Hub's
 * INITIAL page load. Real bug found live 2026-08-23: listCollectionsWithSnapshots()
 * above returns every tracked row with no LIMIT -- it was never given one,
 * not a regression, and the catalog simply grew (317,253 rows / ~211MB JSON
 * at time of fix) past the point that was ever safe for a browser to
 * fetch-and-parse in one response; a real Playwright session and a manual
 * in-page fetch() both hung/failed on it while a server-side curl (no DOM to
 * hold the parsed result in) completed fine. Ranked by real observed 24h
 * sales/volume (a live proxy for "active enough to matter on first paint";
 * the hub's own client-side "grade" sort needs cross-chain recentActivity
 * data this query doesn't have, so this is deliberately an approximation,
 * not a claim of matching it exactly) with vault-backed rows first. Returns
 * a real `totalCount` (via COUNT(*) OVER()) so the UI can honestly show
 * "showing N of totalCount" instead of silently truncating. Search/filter
 * beyond this window is served by the already-paginated, DB-side
 * token-search route (see collection-token-store.ts's searchProjectedTokens
 * and findCollectionsByCreatorSignals above) rather than requiring the full
 * catalog in memory.
 */
/**
 * Real server-side ORDER BY column each `sort` value maps to -- kept a tight
 * whitelist (never string-interpolate the caller's own value into SQL).
 * `grade`/`demand` have no meaning here: both are client-computed composites
 * (gradeScore/computeDemandScore in GlobalMarketHub.tsx) that fold in
 * cross-chain recentActivity data this query doesn't join at all -- for
 * those two, and any unrecognized value, this falls back to the same
 * default ordering the unsorted page has always used (vault-backed first,
 * sales-desc) rather than silently mis-sorting or throwing.
 */
const SORT_COLUMN_SQL: Record<string, string> = {
  name: "c.name",
  floor: "NULLIF(s.floor_price_wei, '')::numeric",
  volume: "NULLIF(s.volume_24h_wei, '')::numeric",
  sales: "s.sales_24h",
  listed: "s.listed_count",
  holders: "s.holder_count",
  change: "s.floor_change_pct",
};

export async function listCollectionsWithSnapshotsPage(input: {
  limit?: number;
  offset?: number;
  /** Real per-chain filter -- when set, both the page AND totalCount are
   * scoped to these chains, so a chain tab's own displayed count (e.g.
   * "4260") becomes fully reachable by paging, not just visible as a number
   * with no path to it. Empty/omitted = the whole catalog, unchanged. */
  chainSlugs?: string[] | null;
  /** Real DB-level ORDER BY column -- see SORT_COLUMN_SQL. Falls back to the
   * default order for grade/demand/unrecognized values. */
  sortColumn?: string | null;
  sortDir?: "asc" | "desc" | null;
} = {}): Promise<{ collections: CollectionWithSnapshot[]; totalCount: number }> {
  const limit = Math.min(Math.max(input.limit ?? 5000, 1), 20000);
  const offset = Math.max(input.offset ?? 0, 0);
  const params: unknown[] = [];
  const whereClauses: string[] = [];
  const chainSlugs = (input.chainSlugs ?? []).filter(Boolean);
  if (chainSlugs.length > 0) {
    params.push(chainSlugs);
    whereClauses.push(`c.chain_slug = ANY($${params.length}::text[])`);
  }
  const dir = input.sortDir === "asc" ? "ASC" : "DESC";
  const sortSql = input.sortColumn ? SORT_COLUMN_SQL[input.sortColumn] : null;
  // NULLS LAST regardless of direction -- a collection with no real value for
  // the chosen column is genuinely absent data, not a "lowest" one; matches
  // compareNullable()'s own always-sorts-to-the-end convention client-side.
  const orderBy = sortSql
    ? `${sortSql} ${dir} NULLS LAST, (c.is_vault_backed IS TRUE) DESC, s.sales_24h DESC NULLS LAST, c.chain_slug, c.contract_address`
    : `(c.is_vault_backed IS TRUE) DESC, s.sales_24h DESC NULLS LAST, s.sales_7d DESC NULLS LAST, c.chain_slug, c.contract_address`;
  params.push(limit, offset);
  const result = await postgresQuery<
    CollectionRow & {
      floor_price_wei: string | null;
      floor_price_currency: string | null;
      floor_price_marketplace: string | null;
      total_supply: string | null;
      listed_count: number | null;
      synced_at: string | null;
      sync_error: string | null;
      volume_24h_wei: string | null;
      sales_24h: number | null;
      volume_7d_wei: string | null;
      sales_7d: number | null;
      volume_30d_wei: string | null;
      sales_30d: number | null;
      previous_floor_price_wei: string | null;
      holder_count: number | null;
      floor_change_pct: number | null;
      total_count: string;
    }
  >(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url, c.is_vault_backed,
            c.creator_handle, c.creator_address, c.creator_ens,
            s.floor_price_wei, s.floor_price_currency, s.floor_price_marketplace, s.total_supply, s.listed_count, s.synced_at, s.sync_error,
            s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d, s.volume_30d_wei, s.sales_30d, s.previous_floor_price_wei,
            s.holder_count, s.floor_change_pct,
            COUNT(*) OVER() AS total_count
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     ${whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : ""}
     ORDER BY ${orderBy}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const totalCount = result.rows.length ? Number(result.rows[0].total_count) : 0;
  const collections = result.rows.map((row) => ({
    ...rowToCollection(row),
    floorPriceWei: row.floor_price_wei,
    floorPriceCurrency: row.floor_price_currency,
    floorPriceMarketplace: row.floor_price_marketplace,
    totalSupply: row.total_supply == null ? null : Number(row.total_supply),
    listedCount: row.listed_count,
    syncedAt: row.synced_at,
    syncError: row.sync_error,
    volume24hWei: row.volume_24h_wei,
    sales24h: row.sales_24h,
    volume7dWei: row.volume_7d_wei,
    sales7d: row.sales_7d,
    volume30dWei: row.volume_30d_wei,
    sales30d: row.sales_30d,
    previousFloorPriceWei: row.previous_floor_price_wei,
    holderCount: row.holder_count,
    floorChangePct: row.floor_change_pct,
  }));
  return { collections, totalCount };
}

/**
 * Real server-side, full-catalog collection NAME/address search.
 *
 * REAL BUG FIXED 2026-08-23, flagged live ("something is bricking the
 * search results"): GlobalMarketHub's search box only ever filtered the
 * `collections` React state -- which, since the infinite-scroll rebuild
 * earlier this session, holds only whatever rows have actually scrolled
 * into view, never the full ~383,000-row catalog. Searching for a real,
 * genuinely tracked collection (confirmed live: Yonder, a real Bitcoin
 * Ordinals collection with 121 real indexed pieces) returned "no
 * collections match" simply because it had never been scrolled to, not
 * because it doesn't exist. This function is the real fix: it queries the
 * full table directly, independent of whatever page the infinite scroll
 * happens to have loaded client-side.
 */
export async function searchTrackedCollectionsByName(
  query: string,
  input: { limit?: number; chainSlugs?: string[] | null } = {}
): Promise<CollectionWithSnapshot[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  const params: unknown[] = [`%${q}%`, q];
  const whereClauses = [`(c.name ILIKE $1 OR c.contract_address ILIKE $1)`];
  const chainSlugs = (input.chainSlugs ?? []).filter(Boolean);
  if (chainSlugs.length > 0) {
    params.push(chainSlugs);
    whereClauses.push(`c.chain_slug = ANY($${params.length}::text[])`);
  }
  params.push(limit);
  const result = await postgresQuery<
    CollectionRow & {
      floor_price_wei: string | null;
      floor_price_currency: string | null;
      floor_price_marketplace: string | null;
      total_supply: string | null;
      listed_count: number | null;
      synced_at: string | null;
      sync_error: string | null;
      volume_24h_wei: string | null;
      sales_24h: number | null;
      volume_7d_wei: string | null;
      sales_7d: number | null;
      volume_30d_wei: string | null;
      sales_30d: number | null;
      previous_floor_price_wei: string | null;
      holder_count: number | null;
      floor_change_pct: number | null;
    }
  >(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url, c.is_vault_backed,
            c.creator_handle, c.creator_address, c.creator_ens,
            s.floor_price_wei, s.floor_price_currency, s.floor_price_marketplace, s.total_supply, s.listed_count, s.synced_at, s.sync_error,
            s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d, s.volume_30d_wei, s.sales_30d, s.previous_floor_price_wei,
            s.holder_count, s.floor_change_pct
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE ${whereClauses.join(" AND ")}
     ORDER BY
       (c.name ILIKE $2) DESC,
       (c.name ILIKE $2 || '%') DESC,
       (c.is_vault_backed IS TRUE) DESC,
       s.sales_24h DESC NULLS LAST,
       c.chain_slug, c.contract_address
     LIMIT $${params.length}`,
    params
  );
  return result.rows.map((row) => ({
    ...rowToCollection(row),
    floorPriceWei: row.floor_price_wei,
    floorPriceCurrency: row.floor_price_currency,
    floorPriceMarketplace: row.floor_price_marketplace,
    totalSupply: row.total_supply == null ? null : Number(row.total_supply),
    listedCount: row.listed_count,
    syncedAt: row.synced_at,
    syncError: row.sync_error,
    volume24hWei: row.volume_24h_wei,
    sales24h: row.sales_24h,
    volume7dWei: row.volume_7d_wei,
    sales7d: row.sales_7d,
    volume30dWei: row.volume_30d_wei,
    sales30d: row.sales_30d,
    previousFloorPriceWei: row.previous_floor_price_wei,
    holderCount: row.holder_count,
    floorChangePct: row.floor_change_pct,
  }));
}

/** Bounded keyset page for edge-cached market feeds. Unlike the legacy hub
 * dump, latency and payload size stay constant as the roster grows. */
export async function listCollectionFeed(input: {
  limit?: number;
  afterId?: number | null;
  chainSlug?: string | null;
} = {}): Promise<{ collections: CollectionWithSnapshot[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 100);
  const clauses = ["c.id > $1"];
  const params: unknown[] = [Math.max(0, input.afterId ?? 0)];
  if (input.chainSlug) {
    params.push(input.chainSlug);
    clauses.push(`c.chain_slug = $${params.length}`);
  }
  params.push(limit + 1);
  const result = await postgresQuery<CollectionRow & {
    floor_price_wei: string | null; floor_price_currency: string | null; floor_price_marketplace: string | null;
    total_supply: string | null; listed_count: number | null; synced_at: string | null; sync_error: string | null;
    volume_24h_wei: string | null; sales_24h: number | null; volume_7d_wei: string | null; sales_7d: number | null;
    volume_30d_wei: string | null; sales_30d: number | null; previous_floor_price_wei: string | null;
    holder_count: number | null; floor_change_pct: number | null;
  }>(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url,
            c.is_vault_backed, c.creator_handle, c.creator_address, c.creator_ens,
            s.floor_price_wei, s.floor_price_currency, s.floor_price_marketplace, s.total_supply, s.listed_count,
            s.synced_at, s.sync_error, s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d,
            s.volume_30d_wei, s.sales_30d, s.previous_floor_price_wei, s.holder_count, s.floor_change_pct
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE ${clauses.join(" AND ")}
     ORDER BY c.id ASC
     LIMIT $${params.length}`,
    params
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const collections = rows.map((row) => ({
    ...rowToCollection(row),
    floorPriceWei: row.floor_price_wei,
    floorPriceCurrency: row.floor_price_currency,
    floorPriceMarketplace: row.floor_price_marketplace,
    totalSupply: row.total_supply == null ? null : Number(row.total_supply),
    listedCount: row.listed_count,
    syncedAt: row.synced_at,
    syncError: row.sync_error,
    volume24hWei: row.volume_24h_wei,
    sales24h: row.sales_24h,
    volume7dWei: row.volume_7d_wei,
    sales7d: row.sales_7d,
    volume30dWei: row.volume_30d_wei,
    sales30d: row.sales_30d,
    previousFloorPriceWei: row.previous_floor_price_wei,
    holderCount: row.holder_count,
    floorChangePct: row.floor_change_pct,
  }));
  return { collections, nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null };
}

/**
 * Writes a real, freshly-fetched holder count for one collection -- the
 * on-demand path (see fetchHolderCount in alchemy-nft.ts, called from the
 * collection detail page, never from the bulk sync loop). Reuses the same
 * COALESCE-safe upsert writeSnapshot already does for holder_count, without
 * touching floor/listed/supply, which this call has no fresher data for.
 */
export async function updateHolderCount(chainSlug: string, contractAddress: string, holderCount: number): Promise<void> {
  const collection = await postgresQuery<{ id: number }>(
    `SELECT id FROM plank_multichain_collections WHERE chain_slug = $1 AND contract_address = $2`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const id = collection.rows[0]?.id;
  if (!id) return;
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots (collection_id, holder_count, synced_at, sync_error)
     VALUES ($1, $2, NOW(), NULL)
     ON CONFLICT (collection_id) DO UPDATE SET holder_count = EXCLUDED.holder_count`,
    [id, holderCount]
  );
}

/**
 * One collection's real listed-count and total-supply, for the collection
 * detail page's stat bar -- a targeted single-row lookup rather than
 * listCollectionsWithSnapshots()'s full 4000+-row table scan, since the
 * caller only ever needs one (chainSlug, contractAddress) pair at a time.
 */
export async function getCollectionSupplyStats(
  chainSlug: string,
  contractAddress: string
): Promise<{ listedCount: number | null; totalSupply: number | null; holderCount: number | null; floorPriceWei: string | null; floorPriceCurrency: string | null } | null> {
  const result = await postgresQuery<{
    total_supply: string | null;
    listed_count: number | null;
    holder_count: number | null;
    floor_price_wei: string | null;
    floor_price_currency: string | null;
  }>(
    `SELECT s.total_supply, s.listed_count, s.holder_count, s.floor_price_wei, s.floor_price_currency
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1 AND c.contract_address = $2
     LIMIT 1`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    totalSupply: row.total_supply == null ? null : Number(row.total_supply),
    listedCount: row.listed_count,
    holderCount: row.holder_count,
    floorPriceWei: row.floor_price_wei,
    floorPriceCurrency: row.floor_price_currency,
  };
}

/**
 * Single-collection real 24h/7d/30d volume/sales, same source/columns as
 * listCollectionsWithSnapshots (OpenSea's own multi-interval stats response,
 * see rarity-index-runner.ts) -- for the collection detail page, which
 * shouldn't pull the full 6000+-row scan just to show one collection's
 * numbers. Null fields, never fabricated zeroes, until that OpenSea pass has
 * run for this collection.
 */
export async function getCollectionMarketStats(
  chainSlug: string,
  contractAddress: string
): Promise<{
  volume24hWei: string | null;
  sales24h: number | null;
  volume7dWei: string | null;
  sales7d: number | null;
  volume30dWei: string | null;
  sales30d: number | null;
} | null> {
  const result = await postgresQuery<{
    volume_24h_wei: string | null;
    sales_24h: number | null;
    volume_7d_wei: string | null;
    sales_7d: number | null;
    volume_30d_wei: string | null;
    sales_30d: number | null;
  }>(
    `SELECT s.volume_24h_wei, s.sales_24h, s.volume_7d_wei, s.sales_7d, s.volume_30d_wei, s.sales_30d
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1 AND c.contract_address = $2
     LIMIT 1`,
    [chainSlug, normalizeContractAddress(chainSlug, contractAddress)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    volume24hWei: row.volume_24h_wei,
    sales24h: row.sales_24h,
    volume7dWei: row.volume_7d_wei,
    sales7d: row.sales_7d,
    volume30dWei: row.volume_30d_wei,
    sales30d: row.sales_30d,
  };
}

/**
 * Accumulates one scan window's per-contract Transfer tally into
 * plank_multichain_activity_stats (migration 015) -- the self-hosted
 * replacement for a third-party EVM ranking API. Called for EVERY contract
 * seen in a scan (not just candidates crossing the discovery floor), so the
 * table grinds toward a complete picture of chain activity over time even
 * for contracts never individually registered.
 */
export async function recordActivity(
  chainSlug: string,
  tally: Map<string, number>
): Promise<void> {
  if (tally.size === 0) return;
  const day = new Date().toISOString().slice(0, 10);
  // One upsert per contract -- these scans are small (a 10-block window),
  // so a batched multi-row INSERT isn't worth the extra query-building
  // complexity here.
  for (const [contractAddress, count] of tally) {
    await postgresQuery(
      `INSERT INTO plank_multichain_activity_stats (chain_slug, contract_address, activity_day, transfer_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_slug, contract_address, activity_day)
       DO UPDATE SET transfer_count = plank_multichain_activity_stats.transfer_count + EXCLUDED.transfer_count`,
      [chainSlug, contractAddress, day, count]
    );
  }
}

/**
 * Real per-chain total counts across the WHOLE catalog, independent of any
 * page/window/limit -- GROUP BY chain_slug, a real, cheap, indexed-enough
 * aggregate (confirmed live via EXPLAIN ANALYZE against the real ~320k-row
 * table: ~115ms parallel seq scan, no dedicated chain_slug index needed at
 * this size). This is what the Global Market Hub's chain-tab badges must
 * read -- NOT a client-side count over whatever single bounded page happens
 * to be loaded (that undercounts every chain except whichever the ORDER BY
 * happens to front-load, confirmed live: "ARBITRUM 4268" vs the real
 * 17,333+).
 */
export async function getChainCounts(): Promise<Record<string, number>> {
  const result = await postgresQuery<{ chain_slug: string; count: string }>(
    `SELECT chain_slug, COUNT(*) AS count FROM plank_multichain_collections GROUP BY chain_slug`
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) out[row.chain_slug] = Number(row.count);
  return out;
}

export type ActivityRankEntry = { contractAddress: string; totalTransfers: number };

/**
 * Our own ranking: top contracts by SUMMED transfer_count over the trailing
 * window, for one chain. This is what "top by volume" means without a
 * third-party ranking endpoint -- real, observed activity we scanned
 * ourselves, not a marketplace's notion of dollar volume.
 */
export async function getTopByActivity(
  chainSlug: string,
  windowDays: number,
  limit: number
): Promise<ActivityRankEntry[]> {
  const result = await postgresQuery<{ contract_address: string; total_transfers: string }>(
    `SELECT contract_address, SUM(transfer_count) AS total_transfers
     FROM plank_multichain_activity_stats
     WHERE chain_slug = $1 AND activity_day >= CURRENT_DATE - $2::int
     GROUP BY contract_address
     ORDER BY total_transfers DESC
     LIMIT $3`,
    [chainSlug, windowDays, limit]
  );
  return result.rows.map((row) => ({
    contractAddress: row.contract_address,
    totalTransfers: Number(row.total_transfers),
  }));
}
