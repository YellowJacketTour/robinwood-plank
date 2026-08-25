/**
 * Machine-readable sync mesh. Future chain/source PRs extend THIS file
 * plus chain-vines.ts — see docs/marketplank/SPEC-SYNC-MESH.md.
 *
 * A lane is one source × one chain in its own process. Cells list what
 * that lane is allowed to write. exactMatchOnly is always true.
 */

export type MeshCell =
  | "name"
  | "image"
  | "floor"
  | "listedCount"
  | "volume24h"
  | "sales24h"
  | "holders"
  | "rarity";

export type MeshSource =
  | "opensea-stats"
  | "opensea-bulk"
  | "coingecko-nft"
  | "magiceden-solana"
  | "ordinals-wallet"
  | "unisat-collections"
  | "adapter-sync"
  | "seaport-fills"
  | "seaport-fills-genesis"
  | "wyvern-fills"
  | "wyvern-fills-genesis"
  | "blur-fills"
  | "blur-fills-genesis"
  | "x2y2-fills"
  | "x2y2-fills-genesis"
  | "foundation-fills"
  | "foundation-fills-genesis"
  | "sudoswap-fills"
  | "sudoswap-fills-genesis"
  | "rarible-fills"
  | "rarible-fills-genesis"
  | "cryptokitties-fills"
  | "cryptokitties-fills-genesis"
  | "native-robinwood"
  | "hypersync-discovery"
  | "hypersync-backfill"
  | "helius-discovery"
  | "unisat-discovery"
  | "ordiscan-discovery"
  | "robinhood-discovery"
  | "robinhood-backfill"
  | "robinhood-opensea"
  | "robinhood-membership"
  | "robinhood-metadata"
  | "evm-metadata"
  | "unisat-rarity"
  | "unisat-membership"
  | "helius-membership"
  | "opensea-membership"
  | "cryptopunks-native"
  | "archival-frontier"
  | "erc4906-rescan"
  | "ipfs-corroboration";

export type MeshLane = {
  id: string;
  source: MeshSource;
  chainSlug: string;
  cells: MeshCell[];
  /** Seconds a healthy lane should run before yielding. */
  sliceSec: number;
  notes: string;
};

const OS_EVM = [
  "eth-mainnet",
  "polygon-mainnet",
  "arb-mainnet",
  "base-mainnet",
  "opt-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
] as const;

const CG_CHAINS = [
  "eth-mainnet",
  "polygon-mainnet",
  "base-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
  "solana-mainnet",
  "bitcoin-mainnet",
] as const;

const HYPERSYNC_EVM = [...OS_EVM, "zksync-mainnet"] as const;

export const MESH_LANES: MeshLane[] = [
  {
    id: "cryptopunks-native:eth-mainnet",
    source: "cryptopunks-native",
    chainSlug: "eth-mainnet",
    cells: ["floor", "listedCount"],
    sliceSec: 120,
    notes: "Canonical pre-ERC721 CryptoPunks contract-state book; additive to aggregator venues.",
  },
  ...OS_EVM.map((chainSlug) => ({
    id: `opensea-membership:${chainSlug}`,
    source: "opensea-membership" as const,
    chainSlug,
    cells: ["image", "rarity"] as MeshCell[],
    sliceSec: 180,
    notes: "One durable NFT page per tick; public reads use the local projection and completed walks rank locally.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `evm-metadata:${chainSlug}`,
    source: "evm-metadata" as const,
    chainSlug,
    cells: ["image", "rarity"] as MeshCell[],
    sliceSec: 180,
    notes: "Bounded tokenURI then OpenSea per-token enrichment; completes trait coverage without request-path fan-out.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `ipfs-corroboration:${chainSlug}`,
    source: "ipfs-corroboration" as const,
    chainSlug,
    cells: ["image"] as MeshCell[],
    sliceSec: 30,
    notes: "Cross-source corroboration (Grok findings, 2026-08-26): samples ~1% of real IPFS-content-addressed tokens through a second independent gateway to detect gateway-side corruption; never doubles real hydrate traffic.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `erc4906-rescan:${chainSlug}`,
    source: "erc4906-rescan" as const,
    chainSlug,
    cells: ["image", "rarity"] as MeshCell[],
    sliceSec: 60,
    notes: "Hash-First doctrine's real trigger: real ERC-4906 MetadataUpdate events reset exactly the affected tokens for re-verification; advanceEvmTokenMetadata's CID-skip then decides per-token whether a real body re-fetch is actually needed.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `hypersync-discovery:${chainSlug}`,
    source: "hypersync-discovery" as const,
    chainSlug,
    cells: ["name", "image"] as MeshCell[],
    sliceSec: 120,
    notes: "Forward Transfer discovery with a durable per-chain cursor. Metadata hydration remains a separate cell.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `seaport-live:${chainSlug}`,
    source: "seaport-fills" as const,
    chainSlug,
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Canonical Seaport 1.1-1.6 OrderFulfilled live cursor; scans first, then rebuilds collection windows.",
  })),
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `seaport-genesis:${chainSlug}`,
    source: "seaport-fills-genesis" as const,
    chainSlug,
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent block-0-to-head Seaport 1.1-1.6 fill cursor; never advances the live cursor or skips an uncovered range.",
  })),
  {
    id: "wyvern-live:eth-mainnet",
    source: "wyvern-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Wyvern v1/v2 OrdersMatched live cursor; eth-mainnet only, both real deployments never redeployed elsewhere.",
  },
  {
    id: "wyvern-genesis:eth-mainnet",
    source: "wyvern-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head Wyvern v1/v2 fill cursor; never advances the live cursor.",
  },
  {
    id: "cryptokitties-live:eth-mainnet",
    source: "cryptokitties-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "CryptoKitties SaleClockAuction/SiringClockAuction AuctionSuccessful live cursor; eth-mainnet only, pre-dates Wyvern by ~7 months.",
  },
  {
    id: "cryptokitties-genesis:eth-mainnet",
    source: "cryptokitties-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head CryptoKitties native-auction fill cursor; never advances the live cursor.",
  },
  {
    id: "foundation-live:eth-mainnet",
    source: "foundation-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Foundation Market BuyPriceAccepted/OfferAccepted/ReserveAuctionFinalized live cursor; eth-mainnet only.",
  },
  {
    id: "foundation-genesis:eth-mainnet",
    source: "foundation-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head Foundation Market fill cursor; never advances the live cursor.",
  },
  {
    id: "sudoswap-live:eth-mainnet",
    source: "sudoswap-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Sudoswap v1 SwapNFTInPair/SwapNFTOutPair live cursor; eth-mainnet only. Decoded via HyperSync JoinMode.JoinAll receipt-log correlation, not a single-log decode -- see sudoswap-fill-indexer.ts.",
  },
  {
    id: "sudoswap-genesis:eth-mainnet",
    source: "sudoswap-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head Sudoswap v1 fill cursor; never advances the live cursor.",
  },
  {
    id: "rarible-live:eth-mainnet",
    source: "rarible-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Rarible ExchangeV2 Match live cursor; eth-mainnet only. Decoded via the matchOrders transaction's own real calldata (fetched via HyperSync's transaction field selection), not the near-parameterless Match log alone -- see rarible-fill-indexer.ts.",
  },
  {
    id: "rarible-genesis:eth-mainnet",
    source: "rarible-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head Rarible ExchangeV2 fill cursor; never advances the live cursor.",
  },
  {
    id: "blur-live:eth-mainnet",
    source: "blur-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "BlurExchange OrdersMatched live cursor; eth-mainnet only. Blend pooled-bid financing is out of scope -- see blur-fill-indexer.ts.",
  },
  {
    id: "blur-genesis:eth-mainnet",
    source: "blur-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head BlurExchange fill cursor; never advances the live cursor.",
  },
  {
    id: "x2y2-live:eth-mainnet",
    source: "x2y2-fills" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 120,
    notes: "X2Y2_r1 EvInventory live cursor (COMPLETE_SELL_OFFER/COMPLETE_BUY_OFFER only); eth-mainnet only.",
  },
  {
    id: "x2y2-genesis:eth-mainnet",
    source: "x2y2-fills-genesis" as const,
    chainSlug: "eth-mainnet",
    cells: ["volume24h", "sales24h"] as MeshCell[],
    sliceSec: 180,
    notes: "Independent genesis-block-to-head X2Y2_r1 fill cursor; never advances the live cursor.",
  },
  ...HYPERSYNC_EVM.map((chainSlug) => ({
    id: `hypersync-backfill:${chainSlug}`,
    source: "hypersync-backfill" as const,
    chainSlug,
    cells: ["name", "image"] as MeshCell[],
    sliceSec: 180,
    notes: "Gap-free genesis-forward historical discovery with its own durable cursor.",
  })),
  {
    id: "helius-discovery:solana-mainnet",
    source: "helius-discovery",
    chainSlug: "solana-mainnet",
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Exhaustive Metaplex Core collection-account catalog with a resumable DAS cursor; legacy/pNFT collections enter through marketplace discovery and are exhaustively enumerated by DAS grouping once known.",
  },
  {
    id: "helius-membership:solana-mainnet",
    source: "helius-membership",
    chainSlug: "solana-mainnet",
    cells: ["rarity"],
    sliceSec: 180,
    notes: "One durable DAS grouping page per collection tick across Core, legacy NFT, and pNFT standards; resumes to the provider total, then ranks locally.",
  },
  {
    id: "unisat-discovery:bitcoin-mainnet",
    source: "unisat-discovery",
    chainSlug: "bitcoin-mainnet",
    cells: ["name", "image"],
    sliceSec: 60,
    notes: "One exhaustive UniSat registry page per tick; stops honestly at provider total. Ordinals collections are registry provenance, not a Bitcoin consensus primitive.",
  },
  {
    id: "ordiscan-discovery:bitcoin-mainnet",
    source: "ordiscan-discovery",
    chainSlug: "bitcoin-mainnet",
    cells: ["name", "image"],
    sliceSec: 60,
    notes: "One Ordiscan catalog page per tick under its small monthly allowance.",
  },
  {
    id: "unisat-rarity:bitcoin-mainnet",
    source: "unisat-rarity",
    chainSlug: "bitcoin-mainnet",
    cells: ["rarity"],
    sliceSec: 180,
    notes: "At most one stale/unindexed Ordinals collection per tick; every API page reserves shared UniSat daily capacity.",
  },
  {
    id: "unisat-membership:bitcoin-mainnet",
    source: "unisat-membership",
    chainSlug: "bitcoin-mainnet",
    cells: ["image", "rarity"],
    sliceSec: 180,
    notes: "One durable official collection-items page per tick; establishes roster without inventing missing traits.",
  },
  {
    id: "robinhood-discovery:robinhood",
    source: "robinhood-discovery",
    chainSlug: "robinhood",
    cells: ["name", "image"],
    sliceSec: 60,
    notes: "First-party Robinhood Chain Transfer discovery.",
  },
  {
    id: "robinhood-backfill:robinhood",
    source: "robinhood-backfill",
    chainSlug: "robinhood",
    cells: ["name", "image"],
    sliceSec: 180,
    notes: "Independent block-zero Transfer discovery through Robinhood Chain RPC; same ERC-165 admission as the live lane.",
  },
  {
    id: "robinhood-opensea:robinhood",
    source: "robinhood-opensea",
    chainSlug: "robinhood",
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Bounded OpenSea Robinhood catalog page, with direct ERC-165 verification before admission.",
  },
  {
    id: "robinhood-membership:robinhood",
    source: "robinhood-membership",
    chainSlug: "robinhood",
    cells: ["image", "rarity"],
    sliceSec: 180,
    notes: "One durable token-membership page per tick for non-native Robinhood collections.",
  },
  {
    id: "robinhood-metadata:robinhood",
    source: "robinhood-metadata",
    chainSlug: "robinhood",
    cells: ["image", "rarity"],
    sliceSec: 180,
    notes: "Bounded first-party tokenURI enrichment with durable terminal/ retry state; never runs in request paths.",
  },
  {
    id: "os-stats:robinhood",
    source: "opensea-stats",
    chainSlug: "robinhood",
    cells: ["floor", "listedCount", "volume24h", "sales24h", "name", "image", "holders"],
    sliceSec: 180,
    notes: "OpenSea Robinhood floor, listings, and 24h/7d/30d windows; additive to native Marketplank data.",
  },
  ...OS_EVM.map((chainSlug) => ({
    id: `os-stats:${chainSlug}`,
    source: "opensea-stats" as const,
    chainSlug,
    cells: ["floor", "listedCount", "volume24h", "sales24h", "name", "image", "holders"] as MeshCell[],
    sliceSec: 180,
    notes: "Named OpenSea slug only. 404 stats are terminal (__none__). Isolated so ETH 429 cannot skip OP.",
  })),
  ...CG_CHAINS.map((chainSlug) => ({
    id: `cg:${chainSlug}`,
    source: "coingecko-nft" as const,
    chainSlug,
    cells: ["floor", "volume24h", "sales24h", "holders", "name", "image"] as MeshCell[],
    sliceSec: 120,
    notes: "Exact contract or CG id. Details-only monthly v3. Missing-floor first. Upsert only after a real detail.",
  })),
  {
    id: "me:solana-mainnet",
    source: "magiceden-solana",
    chainSlug: "solana-mainnet",
    cells: ["floor", "listedCount", "holders", "name", "image"],
    sliceSec: 120,
    notes: "Exact ME symbol. Do not attach to Helius mints by name.",
  },
  {
    id: "ow:bitcoin-mainnet",
    source: "ordinals-wallet",
    chainSlug: "bitcoin-mainnet",
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Keyless turbo.ordinalswallet.com exact slug. 404 caches none.",
  },
  {
    id: "unisat:bitcoin-mainnet",
    source: "unisat-collections",
    chainSlug: "bitcoin-mainnet",
    cells: ["floor", "listedCount", "holders", "name", "image"],
    sliceSec: 90,
    notes: "List endpoint for art+stats. Exit 0 on 403 jail — OW/CG keep running.",
  },
  {
    id: "adapter:solana-mainnet",
    source: "adapter-sync",
    chainSlug: "solana-mainnet",
    cells: ["floor", "listedCount", "holders"],
    sliceSec: 180,
    notes: "ME/Helius adapters only. Alchemy skipped when jailed.",
  },
  {
    id: "adapter:bitcoin-mainnet",
    source: "adapter-sync",
    chainSlug: "bitcoin-mainnet",
    cells: ["floor", "listedCount", "holders"],
    sliceSec: 120,
    notes: "UniSat/Ordiscan adapters. Skip if UniSat jailed.",
  },
  {
    id: "fills:robinhood",
    source: "seaport-fills",
    chainSlug: "robinhood",
    cells: ["volume24h", "sales24h"],
    sliceSec: 60,
    notes: "Observed fills only.",
  },
  {
    id: "native:robinhood",
    source: "native-robinwood",
    chainSlug: "robinhood",
    cells: ["floor", "listedCount", "holders"],
    sliceSec: 60,
    notes: "getListings(robinwood) + plank.love overlay. Never invent floor.",
  },
  {
    // Opportunistic Archival Ledger cold frontier (docs/marketplank/GROK-
    // FINDINGS-sustainable-archival-mining-2026-08-25.md, build order item
    // 4). Not chain-specific -- runArchivalFrontierLane() itself selects a
    // small cross-chain batch of never/rarely-archived collections from
    // collection_archival_stats and enqueues their REAL per-chain hydration
    // job kinds at DEMAND_PRIORITY.ARCHIVAL_FRONTIER, strictly below plain
    // background cadence. This lane's own job just runs that selector; it
    // never calls a third-party provider directly. Self-gated to run at
    // most once every ARCHIVAL_FRONTIER_MIN_INTERVAL_MS via the durable
    // archival_frontier_runs singleton row, so most ticks are a no-op.
    id: "archival-frontier:cross-chain",
    source: "archival-frontier",
    chainSlug: "eth-mainnet",
    cells: ["rarity"],
    sliceSec: 60,
    notes: "Lowest-priority gap-fill for never/rarely-organically-hit collections; self-gated, cross-chain, additive.",
  },
];

export function lanesForSource(source: MeshSource): MeshLane[] {
  return MESH_LANES.filter((l) => l.source === source);
}

export function lanesForChain(chainSlug: string): MeshLane[] {
  return MESH_LANES.filter((l) => l.chainSlug === chainSlug);
}
