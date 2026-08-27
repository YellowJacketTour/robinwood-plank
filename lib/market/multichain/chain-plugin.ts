/**
 * Real, per-chain capability matrix -- external research brief's own shape
 * ("a chain is a plugin row: id, kind, L1/L2/L3-L4 sources"), built as a
 * DERIVED, read-only view over this app's existing chain registries
 * (foreign-chain-registry.ts's FOREIGN_CHAINS, non-evm-chains.ts's Solana/
 * Bitcoin/Robinhood constants, evm-log-scan.ts's EVM_CHAIN_ID), never a
 * second, independent registry.
 *
 * Deliberately NOT a replacement for hydrationJobSources' own chain
 * branching in collection-demand.ts. That function's per-source completion
 * gating (isMembershipCountComplete/isOpenseaMembershipComplete/
 * isAnchoredMembershipComplete/...) is real, hard-won, live-verified logic
 * -- five distinct incidents fixed tonight alone. Building a second,
 * parallel source of chain truth here and switching hydrationJobSources
 * onto it under time pressure would risk silently reintroducing one of
 * those exact bugs for a chain whose real behavior this derived view gets
 * subtly wrong. This module is the answer to a DIFFERENT, real, valid
 * question -- "what does each chain actually support, at a glance, and
 * what does a newly added chain need to reach parity" -- for admin/health
 * tooling and future chain-addition planning, computed FROM the existing
 * registries so it can never drift out of sync with them the way a
 * hand-maintained duplicate would.
 */
import { FOREIGN_CHAINS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { SOLANA_CHAIN_SLUG, BITCOIN_CHAIN_SLUG, ROBINHOOD_CHAIN_SLUG } from "@/lib/market/multichain/trading/non-evm-chains";
import { EVM_CHAIN_ID } from "@/lib/market/multichain/discovery/evm-log-scan";

export type ChainKind = "evm" | "solana" | "ordinals" | "custom-evm";

export type ChainPlugin = {
  /** This app's own internal chainSlug -- the real join key across every
   * table/route/component, not a CAIP-2 id (no chain here needs one; this
   * app's own convention already works and changing it is out of scope). */
  chainSlug: string;
  kind: ChainKind;
  /** True membership/log-scanning sources -- the fast, real-time-capable
   * "melt to 100%" path when present at all. */
  l1Sources: Array<"hypersync" | "helius-das" | "unisat">;
  /** Book/listings/offers sources. */
  l2Sources: Array<"opensea-rest" | "magiceden" | "unisat" | "native-robinwood">;
  /** Trait/metadata/rarity sources -- always background, never the click path. */
  l3l4Sources: Array<"onchain-multicall" | "ipfs" | "opensea-fallback" | "helius-das" | "unisat">;
};

function evmPlugin(chainSlug: string, hasOpenSea: boolean): ChainPlugin {
  const hasHypersync = chainSlug in EVM_CHAIN_ID;
  return {
    chainSlug,
    kind: chainSlug === ROBINHOOD_CHAIN_SLUG ? "custom-evm" : "evm",
    l1Sources: hasHypersync ? ["hypersync"] : [],
    l2Sources: hasOpenSea ? ["opensea-rest"] : [],
    l3l4Sources: ["onchain-multicall", "ipfs", ...(hasOpenSea ? (["opensea-fallback"] as const) : [])],
  };
}

/**
 * The real, current capability matrix -- recomputed live from the actual
 * registries on every call (not cached/frozen at module load) so it can
 * never go stale relative to a registry change elsewhere in the app.
 */
export function allChainPlugins(): ChainPlugin[] {
  const evmChains = FOREIGN_CHAINS.map((c) => evmPlugin(c.chainSlug, c.openSeaChain != null));
  const robinhood = evmPlugin(ROBINHOOD_CHAIN_SLUG, true);
  const solana: ChainPlugin = {
    chainSlug: SOLANA_CHAIN_SLUG,
    kind: "solana",
    l1Sources: ["helius-das"],
    l2Sources: ["magiceden"],
    l3l4Sources: ["helius-das"],
  };
  const bitcoin: ChainPlugin = {
    chainSlug: BITCOIN_CHAIN_SLUG,
    kind: "ordinals",
    l1Sources: ["unisat"],
    l2Sources: ["unisat"],
    l3l4Sources: ["unisat"],
  };
  return [...evmChains, robinhood, solana, bitcoin];
}

export function chainPlugin(chainSlug: string): ChainPlugin | null {
  return allChainPlugins().find((p) => p.chainSlug === chainSlug) ?? null;
}

/**
 * Real, current gap report -- every EVM chain with real OpenSea coverage
 * but no L1 (HyperSync) coverage, the exact shape of gap Robinhood Chain
 * was in until tonight (fixed: EVM_CHAIN_ID now maps it, live-verified
 * against real HyperSync hostnames returning real, matching block
 * height). Kept as a real, callable audit rather than a one-time comment,
 * so the NEXT such gap surfaces the same way instead of needing another
 * external research pass to rediscover it.
 */
export function chainsMissingL1Coverage(): ChainPlugin[] {
  return allChainPlugins().filter((p) => p.kind !== "solana" && p.kind !== "ordinals" && p.l2Sources.length > 0 && p.l1Sources.length === 0);
}
