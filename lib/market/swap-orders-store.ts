/**
 * Storage for Marketplank-native SWAP/OTC listings (deploy/inmotion/postgres/
 * migrations/022_swap_listings.sql) -- deliberately a SEPARATE store from
 * both lib/market/orders-store.ts (single token id, single currency) and
 * lib/market/bundle-orders-store.ts (N tokens, one collection, one native
 * total): a swap's offer and consideration sides can each independently
 * hold NFTs from DIFFERENT contracts plus an optional native-ETH top-up.
 * Same non-custodial store-and-forward model as every other native order
 * table here -- this module only stores and serves a real signed Seaport
 * order, never constructs or alters one.
 */
import { postgresQuery } from "@/lib/postgres";

export type SwapItem = { contractAddress: string; tokenId: string };

export type SwapListing = {
  id: string;
  chainSlug: string;
  chainId: number;
  maker: string;
  offerItems: SwapItem[];
  considerationItems: SwapItem[];
  considerationNativeWei: string;
  expiresAt: string;
};

type StoredSwapListing = SwapListing & { rawOrder: unknown };

type SwapRow = {
  id: string;
  chain_slug: string;
  chain_id: string;
  maker: string;
  offer_items: SwapItem[];
  consideration_items: SwapItem[];
  consideration_native_wei: string;
  payload: { rawOrder?: unknown } | null;
  expires_at: string;
};

function rowToListing(row: SwapRow): StoredSwapListing {
  return {
    id: row.id,
    chainSlug: row.chain_slug,
    chainId: Number(row.chain_id),
    maker: row.maker,
    offerItems: row.offer_items,
    considerationItems: row.consideration_items,
    considerationNativeWei: row.consideration_native_wei,
    expiresAt: row.expires_at,
    rawOrder: row.payload?.rawOrder ?? null,
  };
}

export async function putSwapListing(listing: SwapListing, rawOrder: unknown): Promise<void> {
  await postgresQuery(
    `INSERT INTO market_swap_listings
       (id, chain_slug, chain_id, maker, offer_items, consideration_items, consideration_native_wei, payload, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::numeric, $8::jsonb, $9, NOW())
     ON CONFLICT (id) DO UPDATE
       SET payload = EXCLUDED.payload,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [
      listing.id,
      listing.chainSlug,
      listing.chainId,
      listing.maker.toLowerCase(),
      JSON.stringify(listing.offerItems),
      JSON.stringify(listing.considerationItems),
      listing.considerationNativeWei,
      JSON.stringify({ rawOrder }),
      listing.expiresAt,
    ]
  );
}

/**
 * Every open swap on a chain -- deliberately NOT scoped to one collection
 * (unlike bundle/single listings): a swap's offer/consideration items can
 * span multiple contracts, so "the collection this listing belongs to" is
 * not a well-defined single value the way it is for every other native
 * order type. Callers that want a per-collection view filter client-side
 * by inspecting offerItems/considerationItems for a matching
 * contractAddress.
 */
export async function getSwapListings(chainSlug: string, opts?: { limit?: number }): Promise<StoredSwapListing[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 100, 200));
  const result = await postgresQuery<SwapRow>(
    `SELECT id, chain_slug, chain_id, maker, offer_items, consideration_items, consideration_native_wei, payload, expires_at
       FROM market_swap_listings
      WHERE chain_slug = $1 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT $2`,
    [chainSlug, limit]
  );
  return result.rows.map(rowToListing);
}

export async function getSwapListingsByMaker(chainSlug: string, maker: string): Promise<StoredSwapListing[]> {
  const result = await postgresQuery<SwapRow>(
    `SELECT id, chain_slug, chain_id, maker, offer_items, consideration_items, consideration_native_wei, payload, expires_at
       FROM market_swap_listings
      WHERE chain_slug = $1 AND maker = $2 AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [chainSlug, maker.toLowerCase()]
  );
  return result.rows.map(rowToListing);
}

export async function getSwapListingRawOrder(id: string): Promise<unknown | null> {
  const result = await postgresQuery<{ raw_order: unknown }>(
    `SELECT payload -> 'rawOrder' AS raw_order
       FROM market_swap_listings
      WHERE id = $1 AND expires_at > NOW()`,
    [id]
  );
  return result.rows[0]?.raw_order ?? null;
}

export async function countSwapListingsByMaker(maker: string): Promise<number> {
  const result = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM market_swap_listings WHERE maker = $1 AND expires_at > NOW()`,
    [maker.toLowerCase()]
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function removeSwapListing(id: string, maker: string): Promise<boolean> {
  const result = await postgresQuery(
    `DELETE FROM market_swap_listings WHERE id = $1 AND maker = $2`,
    [id, maker.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
}
