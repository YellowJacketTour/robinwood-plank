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
  | "native-robinwood"
  | "hypersync-discovery"
  | "hypersync-backfill"
  | "helius-discovery"
  | "unisat-discovery"
  | "ordiscan-discovery"
  | "robinhood-discovery"
  | "robinhood-opensea"
  | "robinhood-membership"
  | "robinhood-metadata"
  | "evm-metadata"
  | "unisat-rarity"
  | "unisat-membership"
  | "helius-membership"
  | "opensea-membership";

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
  ...OS_EVM.map((chainSlug) => ({
    id: `opensea-membership:${chainSlug}`,
    source: "opensea-membership" as const,
    chainSlug,
    cells: ["image", "rarity"] as MeshCell[],
    sliceSec: 180,
    notes: "One durable NFT page per tick; public reads use the local projection and completed walks rank locally.",
  })),
  ...OS_EVM.map((chainSlug) => ({
    id: `evm-metadata:${chainSlug}`,
    source: "evm-metadata" as const,
    chainSlug,
    cells: ["image", "rarity"] as MeshCell[],
    sliceSec: 180,
    notes: "Bounded tokenURI then OpenSea per-token enrichment; completes trait coverage without request-path fan-out.",
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
    notes: "Bounded Helius collection discovery; resumable provider cursor.",
  },
  {
    id: "helius-membership:solana-mainnet",
    source: "helius-membership",
    chainSlug: "solana-mainnet",
    cells: ["rarity"],
    sliceSec: 180,
    notes: "One durable DAS grouping page per collection tick; resumes until complete, then ranks locally.",
  },
  {
    id: "unisat-discovery:bitcoin-mainnet",
    source: "unisat-discovery",
    chainSlug: "bitcoin-mainnet",
    cells: ["name", "image"],
    sliceSec: 60,
    notes: "One exhaustive UniSat catalog page per tick; stops honestly at provider total.",
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
];

export function lanesForSource(source: MeshSource): MeshLane[] {
  return MESH_LANES.filter((l) => l.source === source);
}

export function lanesForChain(chainSlug: string): MeshLane[] {
  return MESH_LANES.filter((l) => l.chainSlug === chainSlug);
}
