/**
 * Per-chain config for FOREIGN-chain Seaport trading (offers/buy-now/sweep
 * against OpenSea's real orderbook on chains other than Robinhood Chain).
 *
 * DELIBERATELY SEPARATE FROM lib/constants.ts
 * ---------------------------------------------
 * lib/constants.ts:265's SEAPORT_ADDRESS and :272's CONDUIT_CONTROLLER_ADDRESS
 * are hardcoded ON PURPOSE, after a security audit, specifically to remove
 * the option of an env-overridable (and therefore misconfigurable) contract
 * address for Robinhood Chain's OWN order book. This file does not touch or
 * reopen that decision -- it is a NEW, additive registry for a genuinely
 * different capability (foreign chains, foreign orderbook), following the
 * same "additive, not a rewrite" pattern lib/market/multichain/ already
 * established relative to lib/market/chain-indexer.ts.
 *
 * WHY THE SAME TWO ADDRESSES APPEAR ON EVERY CHAIN
 * ---------------------------------------------------
 * Seaport 1.6 and its conduit controller are deployed via a deterministic
 * (CREATE2) factory, so the SAME contract address is valid on every chain
 * that has them deployed. Verified live 2026-08-17 via eth_getCode against
 * a real Alchemy key: identical bytecode length at
 * 0x0000000000000068F116a894984e2DB1123eB395 (Seaport) and
 * 0x00000000F9490004C11Cef243f5400493c00Ad63 (conduit controller) on
 * Ethereum, Polygon, Arbitrum, Base, Optimism, BNB Chain, Avalanche, AND
 * zkSync -- so this registry does not need a per-chain contract address at
 * all, only per-chain identity (chainId, RPC, and OpenSea's own chain slug
 * for pulling that chain's real orders).
 *
 * ZKSYNC IS DELIBERATELY EXCLUDED
 * ---------------------------------
 * Confirmed live 2026-08-17: OpenSea's API returns
 * {"errors":["Unrecognized chain: zksync"]} for every slug spelling tried
 * (zksync, zksync-era, zksync_era). Seaport itself IS deployed there (see
 * above), but there is no confirmed free/real order-sourcing path for it,
 * so it is excluded here rather than silently included with no orders ever
 * resolving. It remains fully covered by the READ-ONLY multichain indexer
 * (lib/market/multichain/adapters/alchemy-nft.ts +
 * discovery/evm-log-scan.ts) -- only trading is affected.
 */

export type ForeignChainConfig = {
  /** Matches lib/market/multichain's chainSlug convention (e.g. alchemy-nft.ts). */
  chainSlug: string;
  chainId: number;
  /** OpenSea's own chain identifier for this chain -- confirmed live, NOT always the obvious name (Polygon is "matic", BNB Chain is "bsc"). */
  openSeaChain: string;
};

/**
 * Robinhood Chain (4663) is intentionally absent -- its trading path is
 * lib/market/seaport.ts + lib/constants.ts, unaffected by this file.
 */
export const FOREIGN_CHAINS: ForeignChainConfig[] = [
  { chainSlug: "eth-mainnet", chainId: 1, openSeaChain: "ethereum" },
  { chainSlug: "polygon-mainnet", chainId: 137, openSeaChain: "matic" },
  { chainSlug: "arb-mainnet", chainId: 42161, openSeaChain: "arbitrum" },
  { chainSlug: "base-mainnet", chainId: 8453, openSeaChain: "base" },
  { chainSlug: "opt-mainnet", chainId: 10, openSeaChain: "optimism" },
  { chainSlug: "bnb-mainnet", chainId: 56, openSeaChain: "bsc" },
  { chainSlug: "avax-mainnet", chainId: 43114, openSeaChain: "avalanche" },
  // zksync-mainnet deliberately omitted -- see header comment.
];

export function foreignChainByChainSlug(chainSlug: string): ForeignChainConfig | null {
  return FOREIGN_CHAINS.find((c) => c.chainSlug === chainSlug) ?? null;
}

/**
 * Both addresses are the SAME on every chain in FOREIGN_CHAINS (see header
 * comment) -- exported as constants, not a per-chain map, so a future chain
 * addition doesn't need to guess/re-verify an address that a deterministic
 * deployment already guarantees is identical. If a genuinely different-
 * address chain is ever added, this becomes a per-chain field instead: do
 * NOT silently assume identical addresses for a chain not already verified
 * live via eth_getCode the way the 8 chains above were.
 */
export const FOREIGN_SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
export const FOREIGN_CONDUIT_CONTROLLER_ADDRESS = "0x00000000F9490004C11Cef243f5400493c00Ad63";
