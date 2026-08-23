/**
 * Canonical marketplace/protocol registry.
 *
 * This is deliberately a coverage registry, not a marketing claim. A venue is
 * only `indexed` when its adapter writes normalized rows into the canonical
 * ledger. `planned` and `unavailable` remain visible gaps and MUST NOT be
 * converted into zero sales, zero listings, or complete-history claims.
 */
export type MarketFamily = "evm" | "solana" | "bitcoin";
export type MarketCoverage = "indexed" | "partial" | "planned" | "unavailable";
export type MarketCapability = "sales" | "transfers" | "listings" | "bids";

export type MarketVenue = {
  id: string;
  label: string;
  family: MarketFamily;
  protocol: string;
  versions: readonly string[];
  capabilities: readonly MarketCapability[];
  coverage: MarketCoverage;
  /** Empty means the adapter is intended to be chain-discovered. */
  chainSlugs: readonly string[];
  notes: string;
};

export const MARKET_VENUES = [
  { id: "marketplank", label: "Marketplank", family: "evm", protocol: "seaport", versions: ["1.6"], capabilities: ["sales", "listings", "bids"], coverage: "indexed", chainSlugs: [], notes: "First-party signed orders and on-chain fills." },
  { id: "opensea-seaport-1.6", label: "OpenSea / Seaport 1.6", family: "evm", protocol: "seaport", versions: ["1.6"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: [], notes: "On-chain fill ledger plus current OpenSea API windows; history completeness remains explicit." },
  { id: "opensea-seaport-legacy", label: "OpenSea / legacy Seaport", family: "evm", protocol: "seaport", versions: ["1.1", "1.2", "1.3", "1.4", "1.5"], capabilities: ["sales", "transfers"], coverage: "planned", chainSlugs: [], notes: "Requires deployment-address registry and genesis-to-tip event backfill per chain." },
  { id: "opensea-wyvern", label: "OpenSea / Wyvern", family: "evm", protocol: "wyvern", versions: ["2.2", "2.3"], capabilities: ["sales"], coverage: "planned", chainSlugs: ["eth-mainnet"], notes: "Pre-Seaport OpenSea history; normalize atomic matches and fee legs." },
  { id: "cryptopunks-native", label: "CryptoPunks native market", family: "evm", protocol: "cryptopunks-native", versions: ["original"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "planned", chainSlugs: ["eth-mainnet"], notes: "PunkOffered/PunkNoLongerForSale/PunkBought plus current offer state. Adapter absence is unknown, never zero." },
  { id: "blur", label: "Blur", family: "evm", protocol: "blur", versions: ["v1", "v2"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["eth-mainnet", "blast-mainnet"], notes: "Exchange executions and pool bids require protocol-specific decoding." },
  { id: "looksrare", label: "LooksRare", family: "evm", protocol: "looksrare", versions: ["v1", "v2"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: [], notes: "Versioned exchange adapters with shared canonical dedupe." },
  { id: "x2y2", label: "X2Y2", family: "evm", protocol: "x2y2", versions: ["v1"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["eth-mainnet"], notes: "Inventory and execution events require item-level allocation." },
  { id: "sudoswap", label: "Sudoswap", family: "evm", protocol: "sudoswap", versions: ["v1", "v2"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: [], notes: "AMM swaps are normalized as pool-mediated sales, not orderbook fills." },
  { id: "magiceden-solana", label: "Magic Eden", family: "solana", protocol: "magiceden", versions: ["current"], capabilities: ["sales", "transfers", "listings", "bids"], coverage: "partial", chainSlugs: ["solana-mainnet"], notes: "Recent API activity exists; program-history and complete book ingestion remain incomplete." },
  { id: "tensor-solana", label: "Tensor", family: "solana", protocol: "tensor", versions: ["current"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["solana-mainnet"], notes: "Program/account decoder and compressed-NFT support required." },
  { id: "metaplex-solana", label: "Metaplex programs", family: "solana", protocol: "metaplex", versions: ["auction-house", "bubblegum", "core"], capabilities: ["sales", "transfers"], coverage: "planned", chainSlugs: ["solana-mainnet"], notes: "Program-family provenance including compressed and Core assets." },
  { id: "unisat-bitcoin", label: "UniSat", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["listings"], coverage: "partial", chainSlugs: ["bitcoin-mainnet"], notes: "Membership/listing evidence exists; complete sale history is not yet indexed." },
  { id: "magiceden-bitcoin", label: "Magic Eden Ordinals", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["sales", "listings", "bids"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "PSBT sale/listing history must retain inscription and UTXO provenance." },
  { id: "okx-bitcoin", label: "OKX Ordinals", family: "bitcoin", protocol: "ordinals-market", versions: ["current"], capabilities: ["sales", "listings"], coverage: "planned", chainSlugs: ["bitcoin-mainnet"], notes: "External venue coverage; never inferred from a different marketplace." },
] as const satisfies readonly MarketVenue[];

export function venuesForChain(chainSlug: string): readonly MarketVenue[] {
  const family: MarketFamily = chainSlug.startsWith("solana") ? "solana" : chainSlug.startsWith("bitcoin") ? "bitcoin" : "evm";
  return MARKET_VENUES.filter((venue) => venue.family === family && (venue.chainSlugs.length === 0 || venue.chainSlugs.includes(chainSlug as never)));
}

export function isCompleteVenueCoverage(venues: readonly MarketVenue[]): boolean {
  return venues.length > 0 && venues.every((venue) => venue.coverage === "indexed");
}

const NATIVE_BOOK_COLLECTIONS = new Set([
  "eth-mainnet:0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb", // CryptoPunks
]);

/** True when generic order adapters cannot prove the collection's live book. */
export function hasUnindexedNativeBook(chainSlug: string, collectionKey: string): boolean {
  return NATIVE_BOOK_COLLECTIONS.has(`${chainSlug}:${collectionKey.toLowerCase()}`);
}
