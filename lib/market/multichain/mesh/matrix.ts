/**
 * Machine-readable sync mesh. Future chain/source PRs extend THIS file
 * plus chain-vines.ts — see docs/marketplank/SPEC-SYNC-MESH.md.
 *
 * A lane is one source × one chain in its own process. Cells list what
 * that lane is allowed to write. exactMatchOnly is always true.
 */

import { coingeckoSlugs, hypersyncEvmSlugs, openSeaEvmSlugs } from "@/lib/market/multichain/chains/manifest";

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
  | "magiceden-catalog"
  | "magiceden-alias"
  | "bestinslot-stats"
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
  | "anchored-membership"
  | "token-index-probe"
  | "cryptopunks-native"
  | "archival-frontier"
  | "erc4906-rescan"
  | "ipfs-corroboration"
  | "fills-reconcile"
  | "plank-koth-watch"
  | "hunter-evm"
  | "hunter-solana"
  | "hunter-bitcoin"
  | "parity"
  | "creator-identity"
  | "ow-rarity"
  | "ow-catalog"
  | "akasha-bridge"
  | "retention"
  | "m2-sweep";

export type MeshLane = {
  id: string;
  source: MeshSource;
  chainSlug: string;
  cells: MeshCell[];
  /** Seconds a healthy lane should run before yielding. */
  sliceSec: number;
  notes: string;
};

const OS_EVM = openSeaEvmSlugs();

const CG_CHAINS = coingeckoSlugs();

const HYPERSYNC_EVM = hypersyncEvmSlugs();

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
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Exact ME symbol art hydration (hydrateSolanaFromMagicEden). Floor/listed/holders for symbol rows come from adapter:solana-mainnet; for Helius rows from magiceden-alias. Cells corrected 2026-09-06 (AUDIT lens 1 overstatement).",
  },
  {
    // AUDIT lens 1 #6 (2026-09-06, Batch E4): the exhaustive ME catalog
    // walk only ran from a local-dev supervisor, so prod Solana coverage
    // was MplCore + ME top-N (184 rows). One bounded catalog slice per tick,
    // durable offset cursor, `done` re-walks every 6 h.
    id: "magiceden-catalog:solana-mainnet",
    source: "magiceden-catalog",
    chainSlug: "solana-mainnet",
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Exhaustive keyless ME /v2/collections walk, 25 pages per tick; registers symbol rows for the legacy/pNFT long tail.",
  },
  {
    // AUDIT lens 1 #7 (2026-09-06, Batch E4): Helius-discovered rows are
    // keyed by a collection asset id and structurally never got a floor.
    // Resolves each row's ME symbol (DAS grouping member -> ME token ->
    // collection symbol) into alias_symbol (migration 102) and routes
    // floor/listed/holders through the ME adapter by that alias.
    id: "magiceden-alias:solana-mainnet",
    source: "magiceden-alias",
    chainSlug: "solana-mainnet",
    cells: ["floor", "listedCount", "holders"],
    sliceSec: 120,
    notes: "Helius rows only. Alias resolved once (7-day negative cache); stats by alias; two consecutive ME misses null the floor.",
  },
  {
    // RETENTION. The only table here that grows without bound:
    // plank_collection_floor_observations admits one row per collection per
    // marketplace per MINUTE, carries three B-trees per insert, and across
    // 107 prior migrations nothing ever deleted from it.
    //
    // Cross-chain, not per-chain: the prune is a single bounded DELETE by
    // observed_at, and running it eleven times over would just contend with
    // itself for the same rows.
    id: "retention:cross-chain",
    source: "retention",
    // The id says cross-chain; the chainSlug must still name a REAL manifest
    // chain, because chain-manifest.test.ts requires every lane to. The
    // existing archival-frontier:cross-chain and fills-reconcile:cross-chain
    // lanes use the same convention -- an invented slug fails that test, and
    // rightly: a lane whose chain does not exist cannot be scheduled or
    // jailed like any other.
    chainSlug: "eth-mainnet",
    cells: [],
    sliceSec: 30,
    notes: "Prunes floor observations older than 30 days in bounded passes; the only reader needs the newest row and one >=24h old.",
  },
  {
    // THE TAPE -> CATALOG BRIDGE. The replacement for the four vendor catalog
    // pagers, and the reason the cutover is a hand-off rather than a switch-off.
    //
    // Mints one collection per Ordinals parent declaration (envelope tag 3),
    // which is a chain fact rather than a vendor opinion. Runs whether or not
    // the cutover is armed: while the pagers are alive it adds what the chain
    // knows and they do not, and when they retire it is already the writer.
    id: "akasha-bridge:bitcoin-mainnet",
    source: "akasha-bridge",
    chainSlug: "bitcoin-mainnet",
    cells: ["name"],
    sliceSec: 60,
    notes: "Reads akasha_event parent declarations and mints a catalog row per parent; existence only, no floors or traits.",
  },
  {
    // Bitcoin's actual catalog walker. OrdinalsWallet's own `total` is
    // 425,201 collections against the 19,577 tracked: this scan existed and
    // worked but lived ONLY in the legacy refresh-market-data script, which
    // the mesh never runs, so Bitcoin had no catalog walker scheduled at all.
    id: "ow-catalog:bitcoin-mainnet",
    source: "ow-catalog",
    chainSlug: "bitcoin-mainnet",
    cells: ["name", "image"],
    sliceSec: 120,
    notes: "Keyless turbo.ordinalswallet.com collection catalog, 4 pages x 500 per pass with a durable offset; the source of new Bitcoin collections.",
  },
  {
    // Bitcoin zero-to-full without a key (2026-09-07): OrdinalsWallet's
    // collection enumeration returns every inscription with attributes and
    // rank; UniSat's membership/rarity lanes are key-gated and were failing.
    id: "ow-rarity:bitcoin-mainnet",
    source: "ow-rarity",
    chainSlug: "bitcoin-mainnet",
    cells: ["rarity"],
    sliceSec: 120,
    notes: "Keyless turbo.ordinalswallet.com full-collection enumeration -> membership rows, traits, rank; 3 collections per pass, oldest-first.",
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
    // E4-bitcoin (2026-09-06): Magic Eden's Bitcoin API is gone; BestInSlot
    // aggregates floor/listed/volume across the surviving Ordinals venues.
    // Key-gated (BESTINSLOT_API_KEY); the lane is a clean no-op without it.
    id: "bestinslot-stats:bitcoin-mainnet",
    source: "bestinslot-stats",
    chainSlug: "bitcoin-mainnet",
    cells: ["floor", "listedCount", "volume24h", "sales24h", "holders"],
    sliceSec: 90,
    notes: "BestInSlot collection stats for tracked Ordinals collections, missing/stale floor first. Returns credential-missing without a key.",
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
  // The Hunter (2026-09-07, lib/market/multichain/hunter): one engine,
  // chain-native chunk primitives, no vendor key on the critical path.
  // EVM: adaptive eth_getLogs over the public RPC pool -> activity axis +
  // admission law. Solana: Tensor list-state program accounts -> listed +
  // floor under chain-derived provenance. Bitcoin: mempool.space
  // settlement-first index. Every run leaves a receipt on its job.
  // Review M4: HyperSync lanes record the same activity tallies; when the
  // token is configured the hunter covers only the chains HyperSync does not.
  ...(process.env.ENVIO_API_TOKEN?.trim() ? ["robinhood"] : [...HYPERSYNC_EVM, "robinhood"]).map((chainSlug) => ({
    id: `hunter-evm:${chainSlug}`,
    source: "hunter-evm" as const,
    chainSlug,
    cells: ["name"] as MeshCell[],
    sliceSec: 120,
    notes: "Adaptive chain-wide Transfer log hunt over keyless public RPC; writes 7d activity and admits real collections.",
  })),
  {
    // Magic Eden M2 listings straight from the chain, sharded on the first
    // byte of tokenMint so each getProgramAccounts call is bounded (2026-09-07).
    id: "m2-sweep:solana-mainnet",
    source: "m2-sweep" as const,
    chainSlug: "solana-mainnet",
    cells: ["floor", "listedCount"] as MeshCell[],
    sliceSec: 120,
    notes: "Keyless M2 seller trade-state sweep, 12 shards per pass, per-shard reaping; the Solana hunter unions it with Tensor.",
  },
  {
    id: "hunter-solana:solana-mainnet",
    source: "hunter-solana" as const,
    chainSlug: "solana-mainnet",
    cells: ["floor", "listedCount"] as MeshCell[],
    sliceSec: 120,
    notes: "Tensor on-chain list state via getProgramAccounts -> per-collection listed + floor (provenance rank chain-derived).",
  },
  // Parity oracle (2026-09-07): sample each chain's most active collections
  // and compare our cells with independent references (CoinGecko, Magic
  // Eden, Hiro coverage). Divergence enqueues a resync; verdicts are read
  // by /api/market/multichain/parity-oracle (door) and the hub.
  ...[...HYPERSYNC_EVM, "robinhood", "solana-mainnet", "bitcoin-mainnet"].map((chainSlug) => ({
    id: `parity:${chainSlug}`,
    source: "parity" as const,
    chainSlug,
    cells: ["floor", "listedCount", "volume24h", "sales24h"] as MeshCell[],
    sliceSec: 90,
    notes: "Cross-verification against independent public references; disagreement becomes a resync job.",
  })),
  // Creator identity as its own cell (2026-09-07): the hub's known-creator
  // check was only ever written by the rarity runner, once per collection.
  ...[...HYPERSYNC_EVM, "robinhood", "solana-mainnet", "bitcoin-mainnet"].map((chainSlug) => ({
    id: `creator-identity:${chainSlug}`,
    source: "creator-identity" as const,
    chainSlug,
    cells: ["name"] as MeshCell[],
    sliceSec: 90,
    notes: "Fills creator handle / owner address / ENS from CoinGecko links, Magic Eden detail, on-chain owner() and ENS reverse; 7-day attempt memory.",
  })),
  {
    id: "hunter-bitcoin:bitcoin-mainnet",
    source: "hunter-bitcoin" as const,
    chainSlug: "bitcoin-mainnet",
    cells: ["sales24h", "volume24h"] as MeshCell[],
    sliceSec: 120,
    notes: "Settlement-first: mempool.space tx/outspends for known inscription locations -> confirmed sales.",
  },
  {
    // Real gap found live 2026-08-26: fills_ever_stored was 0 across every
    // one of 558,678 tracked collections (no real caller ever set
    // isFill:true) despite ~79M real fills already indexed across
    // plank_seaport_fills and 8 other venue tables. Cursor-paginated
    // through plank_multichain_collections, small bounded batches, own
    // durable cursor (fills-reconcile.ts) -- same shape as
    // archival-frontier, cross-chain, not per-chain.
    id: "fills-reconcile:cross-chain",
    source: "fills-reconcile",
    chainSlug: "eth-mainnet",
    cells: ["rarity"],
    sliceSec: 30,
    notes: "Bounded, cursor-paginated fills_ever_stored reconciliation against the real per-venue fill tables; display-honesty fix, not a live gate.",
  },
  {
    // Season 2 $PLANK King of the Hill live buy watcher (lib/market/
    // plank-koth-watch.ts). Not per-collection-chain -- watches Robinhood
    // Chain's own canonical $PLANK pools directly via Blockscout, cursor-
    // paginated, own finality-aware cursor. High priority: every real
    // minute this runs late is a minute the live leaderboard/countdown can
    // silently lag a real buy that already happened.
    id: "plank-koth-watch:robinhood",
    source: "plank-koth-watch",
    chainSlug: "robinhood",
    cells: ["rarity"],
    sliceSec: 20,
    notes: "Watches canonical $PLANK/WETH and $PLANK/USDG pools for real buys; runs the fraud-gate pipeline before ever feeding a candidate into the KOTH state machine.",
  },
];

/**
 * CUTOVER STEP 3. The Bitcoin catalog pagers, and nothing else.
 *
 * These four lanes are the vendor-catalog path for Bitcoin COLLECTION
 * DISCOVERY: they page third-party registries looking for collections that
 * exist. When the akasha hose owns Bitcoin, that job belongs to the hose --
 * two writers discovering the same existence from different sources is the
 * failure this whole program exists to remove.
 *
 * Deliberately NOT in this set:
 *   - unisat-rarity / ow-rarity / metadata lanes. Rarity and metadata are a
 *     different question from existence, the hose does not answer them yet,
 *     and switching them off would blank real cells for no gain.
 *   - every non-Bitcoin lane. One family at a time is the supported cutover.
 */
export const BITCOIN_CATALOG_LANES: readonly MeshSource[] = [
  "ow-catalog",
  "unisat-discovery",
  "ordiscan-discovery",
  "unisat-collections",
] as const;

/**
 * True once the hose owns Bitcoin existence.
 *
 * Read at call time, never captured at module load, so a supervisor can flip
 * it without a rebuild. Default OFF: the pagers keep running until someone
 * deliberately turns them off, because an accidental cutover leaves Bitcoin
 * with NO writer at all -- strictly worse than a pager wasting turns.
 */
export function bitcoinHoseOwnsExistence(): boolean {
  return process.env.AKASHA_HOSE_OWNS_BITCOIN === "1";
}

/**
 * Lanes the scheduler may run right now.
 *
 * The ONLY behaviour change from the flag: while the hose owns Bitcoin
 * existence, the Bitcoin catalog pagers are not scheduled. Everything else --
 * every other chain, every rarity and metadata lane, Bitcoin included --
 * is untouched.
 */
export function activeMeshLanes(): MeshLane[] {
  if (!bitcoinHoseOwnsExistence()) return MESH_LANES;
  // A HAND-OFF REQUIRES A RECEIVER.
  //
  // This used to be purely subtractive: the flag removed four vendor pagers
  // and put nothing in their place, because the hose could not write a
  // catalog row at all. Arming it therefore left Bitcoin existence with NO
  // writer -- the exact outcome the comment above warns about, reachable by
  // setting the flag it describes. It was armed on production 2026-09-09 and
  // disarmed once measured.
  //
  // Refuse the subtraction unless the bridge that replaces them is scheduled.
  // A cutover that cannot name its receiver is not a cutover.
  const hasBridge = MESH_LANES.some(
    (l) => l.chainSlug === "bitcoin-mainnet" && l.source === "akasha-bridge",
  );
  if (!hasBridge) return MESH_LANES;
  return MESH_LANES.filter(
    (l) =>
      !(l.chainSlug === "bitcoin-mainnet" && BITCOIN_CATALOG_LANES.includes(l.source)),
  );
}

export function lanesForSource(source: MeshSource): MeshLane[] {
  return MESH_LANES.filter((l) => l.source === source);
}

export function lanesForChain(chainSlug: string): MeshLane[] {
  return MESH_LANES.filter((l) => l.chainSlug === chainSlug);
}
