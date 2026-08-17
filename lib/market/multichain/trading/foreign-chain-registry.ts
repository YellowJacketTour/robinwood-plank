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

/** Human-readable chain name for UI badges/labels -- one source of truth, not restated per component. */
const CHAIN_DISPLAY_NAME: Record<string, string> = {
  "eth-mainnet": "Ethereum",
  "polygon-mainnet": "Polygon",
  "arb-mainnet": "Arbitrum",
  "base-mainnet": "Base",
  "opt-mainnet": "Optimism",
  "bnb-mainnet": "BNB Chain",
  "avax-mainnet": "Avalanche",
  "zksync-mainnet": "zkSync",
  "solana-mainnet": "Solana",
};

export function chainDisplayName(chainSlug: string): string {
  return CHAIN_DISPLAY_NAME[chainSlug] ?? chainSlug;
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

/**
 * MarketplankForeignFeeRouter's deployed address per chain
 * (contracts/MarketplankForeignFeeRouter.sol). EVERY entry is null right
 * now -- this contract has NOT been deployed to any real chain yet, on
 * purpose (new code moving real money gets deployed only after explicit
 * review, a separate deliberate step from writing and testing it -- see
 * that contract's own header comment and
 * scripts/verify-foreign-fee-router-fork.ts for the live-fork proof this
 * was verified against instead).
 *
 * A chain with a null address here MUST NOT be offered a Buy/Sweep
 * affordance -- see isCrossChainBuyable() in lib/market/types.ts and
 * foreign-fulfill.ts's own guard, which both fail closed (View-only,
 * exactly the pre-existing behavior) rather than attempt a call against an
 * address that doesn't exist. Fill in a real address here ONLY after a
 * real deployment + verification on that specific chain -- never guess or
 * pre-populate one.
 */
export const FOREIGN_FEE_ROUTER_ADDRESS: Record<string, string | null> = {
  "eth-mainnet": null,
  "polygon-mainnet": null,
  "arb-mainnet": null,
  "base-mainnet": null,
  "opt-mainnet": null,
  "bnb-mainnet": null,
  "avax-mainnet": null,
};

export function foreignFeeRouterAddress(chainSlug: string): string | null {
  return FOREIGN_FEE_ROUTER_ADDRESS[chainSlug] ?? null;
}

/**
 * UI-DISPLAY ESTIMATE ONLY -- matches MarketplankForeignFeeRouter's
 * constructor argument at intended deployment time (1.8%, chosen to stay
 * "plank lore consistent," half of OpenSea's ~2.5% standard fee). The
 * ACTUAL enforced rate always comes from the deployed contract's own
 * feeBps() (immutable, read live in foreign-fulfill.ts's connectedRouter)
 * -- if this constant ever drifted from a real deployment's true rate, the
 * confirm modal would show a slightly wrong number, but the contract
 * itself would still charge exactly what it was deployed with, never more
 * or less than what gets signed. This exists only so the confirm modal has
 * something to show before a wallet is connected to read the real value.
 */
export const FOREIGN_FEE_BPS = 180;
