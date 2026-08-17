/**
 * Storage layer for deploy/inmotion/postgres/migrations/013_multichain_collections.sql.
 * See that migration for why this is a separate, current-state cache rather
 * than an extension of lib/market/chain-events.ts's append-only ledger.
 */
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import type { CollectionSnapshot, TrackedCollection } from "@/lib/market/multichain/types";

export function hasMultichainStore(): boolean {
  return hasPostgresConfig();
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
  };
}

/** Every collection registered for multichain sync. */
export async function listTrackedCollections(): Promise<TrackedCollection[]> {
  const result = await postgresQuery<CollectionRow>(
    `SELECT id, chain_slug, chain_id, contract_address, adapter, name, image_url, external_url, is_vault_backed
     FROM plank_multichain_collections
     ORDER BY chain_slug, contract_address`
  );
  return result.rows.map(rowToCollection);
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
}): Promise<number> {
  const result = await postgresQuery<{ id: number }>(
    `INSERT INTO plank_multichain_collections (chain_slug, chain_id, contract_address, adapter, is_vault_backed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chain_slug, contract_address)
     DO UPDATE SET adapter = EXCLUDED.adapter, is_vault_backed = EXCLUDED.is_vault_backed
     RETURNING id`,
    [
      input.chainSlug,
      input.chainId,
      input.contractAddress.toLowerCase(),
      input.adapter,
      input.isVaultBacked ?? false,
    ]
  );
  return result.rows[0].id;
}

/** Write a fresh snapshot for a collection, and refresh its display fields. */
export async function writeSnapshot(
  collectionId: number,
  snapshot: CollectionSnapshot
): Promise<void> {
  await postgresQuery(
    `UPDATE plank_multichain_collections
     SET name = COALESCE($2, name), image_url = COALESCE($3, image_url), external_url = COALESCE($4, external_url)
     WHERE id = $1`,
    [collectionId, snapshot.name, snapshot.imageUrl, snapshot.externalUrl]
  );
  await postgresQuery(
    `INSERT INTO plank_multichain_snapshots
       (collection_id, floor_price_wei, floor_price_currency, floor_price_marketplace, total_supply, listed_count, synced_at, sync_error)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NULL)
     ON CONFLICT (collection_id) DO UPDATE SET
       floor_price_wei = EXCLUDED.floor_price_wei,
       floor_price_currency = EXCLUDED.floor_price_currency,
       floor_price_marketplace = EXCLUDED.floor_price_marketplace,
       total_supply = EXCLUDED.total_supply,
       listed_count = EXCLUDED.listed_count,
       synced_at = NOW(),
       sync_error = NULL`,
    [
      collectionId,
      snapshot.floorPriceWei,
      snapshot.floorPriceCurrency,
      snapshot.floorPriceMarketplace,
      snapshot.totalSupply,
      snapshot.listedCount,
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
    }
  >(
    `SELECT c.id, c.chain_slug, c.chain_id, c.contract_address, c.adapter, c.name, c.image_url, c.external_url, c.is_vault_backed,
            s.floor_price_wei, s.floor_price_currency, s.floor_price_marketplace, s.total_supply, s.listed_count, s.synced_at, s.sync_error
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
  }));
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
