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
  /** Real handle/wallet "whenever provided" -- OpenSea's creator_username field is null site-wide now (confirmed live); twitter_username and owner are the reliably-populated real fields this actually comes from. Never fabricated: both null when neither is available. */
  creatorHandle: string | null;
  creatorAddress: string | null;
  /** Real ENS name for creatorAddress, "whenever publicly known" (lib/market/multichain/ens.ts) -- never fabricated. */
  creatorEns: string | null;
  /**
   * Real, on-chain-verified ERC-165 standard ("ERC721" | "ERC1155"), when
   * this row's discovery path checked it directly (robinhood-chain-scan.ts
   * does; some foreign-chain adapters do not yet). Null means "never
   * classified" -- callers must treat that the same conservative way as an
   * explicit ERC1155 (not safe to assume ERC721), never guess.
   */
  tokenStandard: "ERC721" | "ERC1155" | null;
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
  /** Real creator wallet, "whenever the adapter's own API exposes one" (e.g. Helius DAS `creators[]`, Alchemy's `contractDeployer`) -- never fabricated or cross-referenced from another source. Optional/undefined for adapters with no such field; explicit null is also honest "checked, none present". */
  creatorAddress?: string | null;
  /** Real creator handle (e.g. a Twitter/X handle), "whenever the adapter's own API exposes one" -- never fabricated. Same optionality as creatorAddress. */
  creatorHandle?: string | null;
  /** Real distinct-owner count, "whenever the adapter's own API exposes one" (e.g. Alchemy's getOwnersForContract owner list length) -- never fabricated or estimated. Same optionality as creatorAddress/creatorHandle: undefined for adapters that don't support it, explicit null is also honest "checked, none present". */
  holderCount?: number | null;
};

/** One entry from a ranked-discovery call — enough to register + seed a snapshot in one step. */
export type DiscoveredCollection = {
  contractAddress: string;
  name: string | null;
  imageUrl: string | null;
  volumeRank: number | null;
  floorPriceRank: number | null;
};

/**
 * A chain adapter knows how to turn ONE (chainSlug, contractAddress) pair
 * into a CollectionSnapshot, using whatever third-party API is appropriate
 * for that chain. Each adapter is free to fail loudly (throw) -- the sync
 * orchestrator (sync.ts) is what decides how a thrown error is recorded, so
 * an adapter never needs its own error-swallowing logic.
 *
 * discoverTopCollections is OPTIONAL and deliberately not on every adapter:
 * it requires the upstream API to expose a genuine ranked-list endpoint
 * (symbol/address + volume + floor in one call), which is real for some
 * providers (Magic Eden's public stats-search, confirmed live) and NOT
 * confirmed free for others (OpenSea's official v2 /collections list has no
 * floor/volume fields at all per their own docs -- a per-collection /stats
 * call exists but needs the slug already known, which is the discovery
 * problem, not a solution to it). An adapter without this method simply
 * can't back automatic top-N discovery yet -- see
 * scripts/discover-multichain-collections.ts for how that's surfaced
 * honestly rather than silently skipped.
 */
export type ChainAdapter = {
  /** Matches the `adapter` column in plank_multichain_collections. */
  readonly name: string;
  fetchSnapshot(input: { chainSlug: string; contractAddress: string }): Promise<CollectionSnapshot>;
  discoverTopCollections?(input: {
    chainSlug: string;
    metric: "volume" | "floorPrice";
    limit: number;
  }): Promise<DiscoveredCollection[]>;
};
