/**
 * Per-chain capability matrix -- the external research brief's own shape
 * ("a chain is a plugin row: id, kind, L1/L2/L3-L4 sources").
 *
 * As of 2026-09-05 this is a thin view over lib/market/multichain/chains/
 * manifest.ts, which is the ONE source of truth every per-chain registry
 * (FOREIGN_CHAINS, EVM_CHAIN_ID, ALCHEMY_NETWORK_SUBDOMAIN, the mesh
 * matrix's chain lists, display maps) is derived from. Before that date it
 * was a derived view over three separate registries that each had to be
 * hand-edited for a new chain.
 *
 * Deliberately still NOT a replacement for hydrationJobSources' own
 * per-source completion gating in collection-demand.ts -- that logic is
 * live-verified incident-by-incident and stays where it is.
 */
import { CHAIN_MANIFESTS, chainManifest, type ChainKind as ManifestChainKind } from "@/lib/market/multichain/chains/manifest";

export type ChainKind = ManifestChainKind;

export type ChainPlugin = {
  chainSlug: string;
  kind: ChainKind;
  /** True membership/log-scanning sources -- the fast, real-time-capable path when present at all. */
  l1Sources: Array<"hypersync" | "helius-das" | "unisat" | "own-scan">;
  /** Book/listings/offers sources. */
  l2Sources: Array<"opensea-rest" | "magiceden" | "unisat" | "native-robinwood">;
  /** Trait/metadata/rarity sources -- always background, never the click path. */
  l3l4Sources: Array<"onchain-multicall" | "ipfs" | "opensea-fallback" | "helius-das" | "unisat">;
};

function fromManifest(m: (typeof CHAIN_MANIFESTS)[number]): ChainPlugin {
  return { chainSlug: m.chainSlug, kind: m.kind, l1Sources: [...m.sources.l1], l2Sources: [...m.sources.l2], l3l4Sources: [...m.sources.l3l4] };
}

/** Recomputed from the manifest on every call so it can never go stale. */
export function allChainPlugins(): ChainPlugin[] {
  return CHAIN_MANIFESTS.map(fromManifest);
}

export function chainPlugin(chainSlug: string): ChainPlugin | null {
  const m = chainManifest(chainSlug);
  return m ? fromManifest(m) : null;
}

/** EVM chains with a book source but no L1 log-scanning coverage -- the gap Robinhood Chain was in until 2026-08-27. */
export function chainsMissingL1Coverage(): ChainPlugin[] {
  return allChainPlugins().filter((p) => p.kind !== "solana" && p.kind !== "ordinals" && p.l2Sources.length > 0 && p.l1Sources.length === 0);
}
