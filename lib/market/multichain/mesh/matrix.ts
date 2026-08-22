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
  | "native-robinwood";

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

export const MESH_LANES: MeshLane[] = [
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
