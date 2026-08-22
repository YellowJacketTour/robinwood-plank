/**
 * Per-chain SPEAK map for Marketplank hub cells.
 *
 * This is the contract for what may fill a hub cell. A cell stays dash
 * until its spoke writes a sourced value. Never invent floors, names,
 * ranks, volume, holders, or traits.
 *
 * Hub GET (`app/api/market/multichain`) stays snapshot-read. Spokes run
 * only in `scripts/spoke-backfill.ts` / `refresh-market-data.ts`, never
 * from the App Router page graph (that compile crash is why hydrate
 * lives in its own API route, not imported into GlobalMarketHub).
 */

export type HubCell =
  | "name"
  | "image"
  | "floor"
  | "listedCount"
  | "listedPct"
  | "volume24h"
  | "sales24h"
  | "holders"
  | "uniqueHolders"
  | "totalSupply"
  | "highestSale"
  | "rarityRanks"
  | "traits"
  | "grade";

export type SpokeKind = "stats" | "discovery" | "rarity" | "listings" | "native";

export type Spoke = {
  id: string;
  chainSlug: string;
  kind: SpokeKind;
  cells: HubCell[];
  /** Existing runner this spoke delegates to. */
  runner: string;
  source: string;
  exactMatchOnly: true;
  notes: string;
};

/** Bespoke spokes. One chain may have several; they do not share adapters. */
export const SPOKES: Spoke[] = [
  {
    id: "evm-opensea-stats",
    chainSlug: "evm-opensea",
    kind: "stats",
    cells: ["floor", "volume24h", "sales24h", "name", "image", "totalSupply"],
    runner: "lib/market/multichain/discovery/opensea-stats.ts#runOpenSeaStatsSync",
    source: "OpenSea v2 /collections/{slug}/stats + contract slug resolve",
    exactMatchOnly: true,
    notes: "ETH/Polygon/Arb/Base/OP/BNB/Avax. Skip zkSync (openSeaChain null). Alchemy NFT API is 429-capped — do not call it.",
  },
  {
    id: "evm-seaport-fills",
    chainSlug: "evm-native-fills",
    kind: "stats",
    cells: ["volume24h", "sales24h"],
    runner: "store.updateEvmVolumeFromSeaportFills",
    source: "plank_seaport_fills first-party index",
    exactMatchOnly: true,
    notes: "Observed fills only. Covers Robinhood when OpenSea has no book.",
  },
  {
    id: "solana-magiceden",
    chainSlug: "solana-mainnet",
    kind: "listings",
    cells: ["floor", "listedCount", "name", "image", "totalSupply"],
    runner: "adapters/magiceden-solana.ts",
    source: "Magic Eden keyless stats + listings (offset pages)",
    exactMatchOnly: true,
    notes: "Symbol vs mint: resolve collection mint before rarity grouping.",
  },
  {
    id: "solana-helius-rarity",
    chainSlug: "solana-mainnet",
    kind: "rarity",
    cells: ["rarityRanks", "traits"],
    runner: "discovery/helius-rarity-index-runner.ts",
    source: "Helius DAS grouping + computeGenericRaritySnapshot (−log2)",
    exactMatchOnly: true,
    notes: "Cap 12k. Dual-write rarity keys. Resume on 1k/2k/5k samples.",
  },
  {
    id: "solana-coingecko",
    chainSlug: "solana-mainnet",
    kind: "stats",
    cells: ["volume24h", "sales24h", "floor"],
    runner: "discovery/coingecko-nft-stats.ts#runCoinGeckoNftStats(solana)",
    source: "CoinGecko NFT platform=solana exact id",
    exactMatchOnly: true,
    notes: "Monthly demo cap ~10k. Jail on 429. Unmatched stays dash.",
  },
  {
    id: "bitcoin-unisat",
    chainSlug: "bitcoin-mainnet",
    kind: "listings",
    cells: ["floor", "listedCount", "name", "totalSupply"],
    runner: "adapters/unisat-collections.ts",
    source: "UniSat collection registry + turbo listings",
    exactMatchOnly: true,
    notes: "All items catalog from plank_foreign_rarity, not listing page size.",
  },
  {
    id: "bitcoin-unisat-rarity",
    chainSlug: "bitcoin-mainnet",
    kind: "rarity",
    cells: ["rarityRanks", "traits"],
    runner: "discovery/unisat-rarity-index-runner.ts",
    source: "UniSat traits + −log2; always partial by construction",
    exactMatchOnly: true,
    notes: "Never claim 100% ordinal coverage.",
  },
  {
    id: "bitcoin-coingecko",
    chainSlug: "bitcoin-mainnet",
    kind: "stats",
    cells: ["volume24h", "sales24h", "floor"],
    runner: "discovery/coingecko-nft-stats.ts#runCoinGeckoNftStats(ordinals)",
    source: "CoinGecko NFT platform=ordinals exact slug",
    exactMatchOnly: true,
    notes: "Exact UniSat slug == CoinGecko id only.",
  },
  {
    id: "robinhood-native",
    chainSlug: "robinhood",
    kind: "native",
    cells: ["floor", "listedCount", "grade"],
    runner: "adapters/robinhood-native.ts + getListings(robinwood) no chain filter",
    source: "Local Seaport book + vault V3 0xacE28f72…",
    exactMatchOnly: true,
    notes: "Grade needs listed OR volume OR isNativeHome+vault. Empty book stays dash for floor.",
  },
  {
    id: "adapter-sync",
    chainSlug: "*",
    kind: "stats",
    cells: ["floor", "listedCount", "name", "image", "holders", "totalSupply"],
    runner: "sync.ts#runMultichainSync (staleness-ordered, batch 800)",
    source: "Per-row adapter (alchemy/ME/unisat/helius/ordiscan/defillama/native)",
    exactMatchOnly: true,
    notes: "Alchemy adapter must no-op / skip when 429-capped. Fair queue so Solana is not starved.",
  },
];

export function spokesForChain(chainSlug: string): Spoke[] {
  return SPOKES.filter((s) => s.chainSlug === chainSlug || s.chainSlug === "*" || (s.chainSlug === "evm-opensea" && chainSlug.endsWith("-mainnet") && chainSlug !== "solana-mainnet" && chainSlug !== "bitcoin-mainnet"));
}
