/**
 * Adapter for collections deployed on Robinhood Chain itself but not
 * RobinWood ($PLANK) -- discovered by robinhood-chain-scan.ts and
 * opensea-robinhood-scan.ts, which register them with adapter:
 * "robinhood-native" (lib/market/multichain/discovery/robinhood-chain-scan.ts:216,
 * opensea-robinhood-scan.ts:210). Found live 2026-08-20: sync.ts's ADAPTERS
 * registry never had an entry for this name at all, so every sync pass
 * silently skipped all 358 of these rows forever ("no adapter registered
 * for \"robinhood-native\"") -- discovery wrote real name/image at
 * registration time (see those scanners' own updateCollectionDisplay
 * calls), but floor/volume/stats could never populate for a single one of
 * them, which is exactly the "24h stats empty" symptom on this app's own
 * chain's foreign-to-RobinWood collections.
 *
 * There is no third-party API for these -- they're not curated by OpenSea,
 * Alchemy has no NFT API coverage for Robinhood Chain, and there is no
 * marketplace-aggregator for a chain this small. The only REAL signal that
 * exists is this app's own Seaport orderbook (market_orders), which
 * already indexes real listings for ANY collection on Robinhood Chain, not
 * just RobinWood's own -- see app/api/market/multichain/native-orders/
 * route.ts's collectionSlug = `${chainSlug}:${contractAddress}` convention,
 * reused verbatim here. Floor is the minimum unexpired real listing price;
 * null when none exists. Never fabricated, never estimated.
 */
import { postgresQuery } from "@/lib/postgres";
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";

type FloorRow = { min_price: string | null; listed_count: string };

export const robinhoodNativeAdapter: ChainAdapter = {
  name: "robinhood-native",
  async fetchSnapshot({ chainSlug, contractAddress }): Promise<CollectionSnapshot> {
    const collectionSlug = `${chainSlug}:${contractAddress.toLowerCase()}`;
    const result = await postgresQuery<FloorRow>(
      `SELECT MIN(price_wei) AS min_price, COUNT(*) AS listed_count
       FROM market_orders
       WHERE chain_slug = $1 AND collection_slug = $2 AND order_kind = 'listing' AND expires_at > NOW()`,
      [chainSlug, collectionSlug]
    );
    const row = result.rows[0];
    const floorPriceWei = row?.min_price ?? null;
    const listedCount = row ? Number(row.listed_count) : 0;
    return {
      // Name/image are already written at discovery time (see this file's
      // own header) and this adapter has no separate source for them --
      // returning null here is correct, not a gap: writeSnapshot (store.ts)
      // only overwrites a field when the new value is non-null.
      name: null,
      imageUrl: null,
      externalUrl: null,
      floorPriceWei,
      floorPriceCurrency: floorPriceWei != null ? "ETH" : null,
      floorPriceMarketplace: floorPriceWei != null ? "marketplank" : null,
      totalSupply: null,
      listedCount: listedCount > 0 ? listedCount : null,
    };
  },
};
