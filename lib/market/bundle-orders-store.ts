/**
 * Storage for Marketplank-native BUNDLE listings (deploy/inmotion/postgres/
 * migrations/020_bundle_listings.sql) -- deliberately a SEPARATE store from
 * lib/market/orders-store.ts's market_orders table, since a bundle's
 * multiple token_ids don't fit that table's single-token_id schema. Same
 * non-custodial store-and-forward model: a bundle is a real signed Seaport
 * order (offer: 2+ ERC-721 items, one native-ETH consideration), this
 * module only stores and serves it.
 */
import { postgresQuery } from "@/lib/postgres";

export type BundleListing = {
  id: string;
  chainSlug: string;
  chainId: number;
  collectionSlug: string;
  maker: string;
  tokenIds: string[];
  priceWei: string;
  expiresAt: string;
};

type StoredBundleListing = BundleListing & { rawOrder: unknown };

type BundleRow = {
  id: string;
  chain_slug: string;
  chain_id: string;
  collection_slug: string;
  maker: string;
  token_ids: string[];
  price_wei: string;
  payload: { rawOrder: unknown } | unknown;
  expires_at: string;
};

function rowToListing(row: BundleRow): StoredBundleListing {
  const payload = row.payload as { rawOrder?: unknown } | null;
  return {
    id: row.id,
    chainSlug: row.chain_slug,
    chainId: Number(row.chain_id),
    collectionSlug: row.collection_slug,
    maker: row.maker,
    tokenIds: row.token_ids,
    priceWei: row.price_wei,
    expiresAt: row.expires_at,
    rawOrder: payload?.rawOrder ?? null,
  };
}

export async function putBundleListing(
  listing: BundleListing,
  rawOrder: unknown
): Promise<void> {
  await postgresQuery(
    `INSERT INTO market_bundle_listings
       (id, chain_slug, chain_id, collection_slug, maker, token_ids, price_wei, payload, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::numeric, $8::jsonb, $9, NOW())
     ON CONFLICT (id) DO UPDATE
       SET payload = EXCLUDED.payload,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [
      listing.id,
      listing.chainSlug,
      listing.chainId,
      listing.collectionSlug,
      listing.maker.toLowerCase(),
      JSON.stringify(listing.tokenIds),
      listing.priceWei,
      JSON.stringify({ rawOrder }),
      listing.expiresAt,
    ]
  );
}

export async function getBundleListings(
  chainSlug: string,
  collectionSlug: string
): Promise<StoredBundleListing[]> {
  const result = await postgresQuery<BundleRow>(
    `SELECT id, chain_slug, chain_id, collection_slug, maker, token_ids, price_wei, payload, expires_at
       FROM market_bundle_listings
      WHERE chain_slug = $1 AND collection_slug = $2 AND expires_at > NOW()
      ORDER BY created_at DESC`,
    [chainSlug, collectionSlug]
  );
  return result.rows.map(rowToListing);
}

export async function getBundleListingRawOrder(id: string): Promise<unknown | null> {
  const result = await postgresQuery<{ raw_order: unknown }>(
    `SELECT payload -> 'rawOrder' AS raw_order
       FROM market_bundle_listings
      WHERE id = $1 AND expires_at > NOW()`,
    [id]
  );
  return result.rows[0]?.raw_order ?? null;
}

export async function countBundleListingsByMaker(maker: string): Promise<number> {
  const result = await postgresQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM market_bundle_listings WHERE maker = $1 AND expires_at > NOW()`,
    [maker.toLowerCase()]
  );
  return Number(result.rows[0]?.count ?? 0);
}
