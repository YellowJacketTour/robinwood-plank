/**
 * The multi-chain collection-indexing layer's core contract.
 *
 * See deploy/inmotion/postgres/migrations/013_multichain_collections.sql for
 * the storage shape this feeds, and this directory's other files for why it
 * is additive alongside lib/market/chain-indexer.ts rather than a
 * replacement or generalization of it -- that file's raw-log business logic
 * is specific to Robinhood Chain + Seaport and is not being touched here.
 */

/** One collection this app tracks via an external indexing API. */
export type TrackedCollection = {
  id: number;
  chainSlug: string;
  chainId: number | null;
  contractAddress: string;
  adapter: string;
  name: string | null;
  imageUrl: string | null;
  externalUrl: string | null;
  isVaultBacked: boolean;
};

/** What a sync writes back for one collection. */
export type CollectionSnapshot = {
  name: string | null;
  imageUrl: string | null;
  externalUrl: string | null;
  floorPriceWei: string | null;
  floorPriceCurrency: string | null;
  floorPriceMarketplace: string | null;
  totalSupply: number | null;
  listedCount: number | null;
};

/**
 * A chain adapter knows how to turn ONE (chainSlug, contractAddress) pair
 * into a CollectionSnapshot, using whatever third-party API is appropriate
 * for that chain. Each adapter is free to fail loudly (throw) -- the sync
 * orchestrator (sync.ts) is what decides how a thrown error is recorded, so
 * an adapter never needs its own error-swallowing logic.
 */
export type ChainAdapter = {
  /** Matches the `adapter` column in plank_multichain_collections. */
  readonly name: string;
  fetchSnapshot(input: { chainSlug: string; contractAddress: string }): Promise<CollectionSnapshot>;
};
