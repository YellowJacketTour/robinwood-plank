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
 * ZKSYNC IS DELIBERATELY EXCLUDED, ON PURPOSE, FOR NOW
 * ---------------------------------------------------------
 * Confirmed live 2026-08-17: OpenSea's API returns
 * {"errors":["Unrecognized chain: zksync"]} for every slug spelling tried
 * (zksync, zksync-era, zksync_era). Seaport itself IS deployed there (see
 * above), but there is no confirmed free/real order-sourcing path for it,
 * so it is excluded here rather than silently included with no orders ever
 * resolving. It remains fully covered by the READ-ONLY multichain indexer
 * (lib/market/multichain/adapters/alchemy-nft.ts +
 * discovery/evm-log-scan.ts) -- only trading is affected.
 *
 * THE FUTURE-INCLUSION PATH -- WHY THIS IS SAFE TO ADD LATER
 * -----------------------------------------------------------------
 * None of MarketplankForeignFeeRouter.sol, MarketplankAcrossReceiver.sol,
 * or MarketplankDeBridgeExecutor.sol contain ANY chain-specific logic --
 * every chain identity (Seaport address, wrapped-native-token address,
 * SpokePool/adapter address) is a constructor argument, not a hardcoded
 * constant. Adding zkSync later, once/if a real order-sourcing path exists
 * for it, is purely additive:
 *   1. Add a FOREIGN_CHAINS entry here (chainId 324, openSeaChain once a
 *      real one exists -- see evm-log-scan.ts's EVM_CHAIN_ID for the
 *      already-confirmed chainId).
 *   2. Deploy the SAME, already-audited-by-this-process contract source to
 *      zkSync with zkSync-specific constructor args (zkSync Era uses its
 *      own zksolc compiler toolchain, not vanilla solc -- the Solidity
 *      SOURCE is unchanged, but it needs a real zkSync-specific compile +
 *      deploy + verify pass of its own, not just an address added to a
 *      registry).
 *   3. Add the resulting real addresses to
 *      FOREIGN_FEE_ROUTER_ADDRESS/FOREIGN_ACROSS_RECEIVER_ADDRESS/
 *      FOREIGN_DEBRIDGE_EXECUTOR_ADDRESS below.
 * Nothing about steps 1-3 requires touching, redeploying, or re-auditing
 * any chain already live -- each chain's router/receiver/executor is an
 * independent deployment of the same source, not a shared or upgradeable
 * contract other chains depend on.
 */

import { ALCHEMY_NETWORK_SUBDOMAIN, apiKey } from "@/lib/market/multichain/adapters/alchemy-nft";

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
  "bitcoin-mainnet": "Bitcoin (Ordinals)",
  robinhood: "Robinhood Chain",
  // "solana"/"bitcoin" (bare, no "-mainnet" suffix) kept as aliases only --
  // an EARLIER pass claimed these were "the REAL chainSlug values" this
  // codebase writes; that was wrong. non-evm-chains.ts's own header (and a
  // live check of what scripts/seed-multichain-collections.ts and
  // discover-multichain-collections.ts actually write to Postgres)
  // confirmed the real, current values are "solana-mainnet" and
  // "bitcoin-mainnet" -- matching every other chain's own "-mainnet"
  // convention. These bare aliases stay only so an old link/bookmark using
  // the earlier (wrong) slug still resolves to a real display name instead
  // of falling back to the raw slug string.
  solana: "Solana",
  bitcoin: "Bitcoin (Ordinals)",
};

export function chainDisplayName(chainSlug: string): string {
  return CHAIN_DISPLAY_NAME[chainSlug] ?? chainSlug;
}

/**
 * Each chain's real, public brand color (from that chain's own published
 * brand kit -- Ethereum's ETH blue-purple, Polygon's purple, Base's blue,
 * etc. -- not an invented palette). Used for at-a-glance chain
 * identification on cards, distinct from the tier-rarity color system.
 */
const CHAIN_BRAND_COLOR: Record<string, string> = {
  "eth-mainnet": "#627EEA",
  "polygon-mainnet": "#8247E5",
  "arb-mainnet": "#28A0F0",
  "base-mainnet": "#0052FF",
  "opt-mainnet": "#FF0420",
  "bnb-mainnet": "#F0B90B",
  "avax-mainnet": "#E84142",
  "zksync-mainnet": "#8C8DFC",
  "solana-mainnet": "#9945FF",
  "bitcoin-mainnet": "#F7931A", // Bitcoin's real published brand orange.
  robinhood: "#eec164", // This app's own gold token (--color-gold-400, app/globals.css) -- Robinhood Chain IS this app, not a third-party brand to source a color from.
  solana: "#9945FF", // alias, see CHAIN_DISPLAY_NAME's header
  bitcoin: "#F7931A", // alias, see CHAIN_DISPLAY_NAME's header
};

export function chainBrandColor(chainSlug: string): string {
  return CHAIN_BRAND_COLOR[chainSlug] ?? "#58BDF0";
}

/** Short glyph for a compact colored chain badge -- avoids hotlinking third-party logo assets while staying instantly recognizable per chain. */
const CHAIN_GLYPH: Record<string, string> = {
  "eth-mainnet": "Ξ",
  "polygon-mainnet": "P",
  "arb-mainnet": "A",
  "base-mainnet": "B",
  "opt-mainnet": "O",
  "bnb-mainnet": "BNB",
  "avax-mainnet": "AVAX",
  "zksync-mainnet": "ZK",
  "solana-mainnet": "S",
  "bitcoin-mainnet": "₿",
  robinhood: "RW",
  solana: "S",
  bitcoin: "₿",
};

export function chainGlyph(chainSlug: string): string {
  return CHAIN_GLYPH[chainSlug] ?? chainSlug.slice(0, 2).toUpperCase();
}

/**
 * The real native/wrapped-gas currency symbol a price on this chain is
 * actually denominated in for display -- pulled out of two places
 * (ForeignOfferForm's currencySymbol prop and ForeignOfferConfirm's) that
 * had independently duplicated the exact same ternary. `isSolana` is a
 * separate parameter (not derived from chainSlug here) because callers
 * already have it computed via non-evm-chains.ts's isSolanaChainSlug, and
 * this file deliberately stays EVM-only otherwise (see FOREIGN_CHAINS'
 * own header on why Solana/Bitcoin aren't folded into this registry).
 */
export function nativeCurrencySymbol(chainSlug: string, isSolana: boolean): string {
  if (isSolana) return "SOL";
  if (chainSlug === "bnb-mainnet") return "WBNB";
  if (chainSlug === "avax-mainnet") return "WAVAX";
  return "WETH";
}

/**
 * Canonical WETH (or chain-native wrapped-gas-token) address per foreign
 * chain -- Seaport cannot pull native ETH from an offerer at fulfillment
 * time (same constraint lib/market/seaport.ts's own buildOffer documents
 * for Robinhood Chain), so every cross-chain offer is denominated in this
 * token. Each address was verified live 2026-08-18 with a real eth_call to
 * symbol() against a public RPC for that exact chain (not copied from a
 * list) -- Ethereum/Arbitrum/Polygon/Base/Optimism all returned "WETH",
 * BNB Chain returned "WBNB", Avalanche returned "WAVAX". Base and
 * Optimism share the literal address 0x4200...0006 because both are
 * OP-stack chains with the same predeploy convention, confirmed
 * independently for Base via a real OpenSea /offers/build response.
 */
const FOREIGN_OFFER_CURRENCY: Record<string, string> = {
  "eth-mainnet": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  "polygon-mainnet": "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "arb-mainnet": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  "base-mainnet": "0x4200000000000000000000000000000000000006",
  "opt-mainnet": "0x4200000000000000000000000000000000000006",
  "bnb-mainnet": "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  "avax-mainnet": "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
};

export function foreignOfferCurrency(chainSlug: string): string | null {
  return FOREIGN_OFFER_CURRENCY[chainSlug] ?? null;
}

/**
 * A real JSON-RPC endpoint for a foreign chain -- for the Marketplank-native
 * listing feature's on-chain ownership check (ethCallForeignFree in
 * lib/market/fetch-rpc.ts), which needs to read against the RIGHT chain,
 * not Robinhood Chain's own RPC. Reuses alchemy-nft.ts's ALCHEMY_NETWORK_SUBDOMAIN
 * map and apiKey() helper rather than maintaining a second, independently-drifting
 * subdomain list -- same host, but Alchemy's raw JSON-RPC product path
 * (/v2/) instead of that adapter's NFT API path (/nft/v3/). Throws (fails
 * closed) for a chainSlug Alchemy doesn't support, same posture as
 * baseUrl() in that adapter.
 */
export function foreignRpcUrls(chainSlug: string): string[] {
  const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    throw new Error(`foreign-chain-registry: no Alchemy RPC mapping for chainSlug "${chainSlug}"`);
  }
  return [`https://${subdomain}.g.alchemy.com/v2/${apiKey()}`];
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
 * MarketplankAcrossReceiver's deployed address per DESTINATION chain
 * (contracts/MarketplankAcrossReceiver.sol). Same posture as
 * FOREIGN_FEE_ROUTER_ADDRESS -- every entry null until a real, reviewed
 * deployment happens on that specific chain. A null entry means the
 * cross-chain-via-Across path is unavailable there; callers must fail
 * closed, never guess an address.
 *
 * "avax-mainnet" is DELIBERATELY ABSENT, not an oversight: confirmed live
 * 2026-08-17 that Across Protocol has no Avalanche deployment at all (see
 * across-quote.ts's header). Avalanche keeps full direct buy-now/sweep
 * support via MarketplankForeignFeeRouter (FOREIGN_FEE_ROUTER_ADDRESS
 * above, unaffected) -- only the pay-from-any-chain Across path can never
 * exist there until Across itself deploys one. "bnb-mainnet" IS present:
 * Across's BNB Chain deployment (a Universal_SpokePool) was verified live
 * the same way as every other chain here.
 */
export const FOREIGN_ACROSS_RECEIVER_ADDRESS: Record<string, string | null> = {
  "eth-mainnet": null,
  "polygon-mainnet": null,
  "arb-mainnet": null,
  "base-mainnet": null,
  "opt-mainnet": null,
  "bnb-mainnet": null,
};

export function foreignAcrossReceiverAddress(chainSlug: string): string | null {
  return FOREIGN_ACROSS_RECEIVER_ADDRESS[chainSlug] ?? null;
}

/**
 * MarketplankDeBridgeExecutor's deployed address per DESTINATION chain
 * (contracts/MarketplankDeBridgeExecutor.sol) -- the BNB-Chain-capable
 * counterpart to FOREIGN_ACROSS_RECEIVER_ADDRESS, since Across has no live
 * route there (see that contract's header). Same null-until-deployed
 * posture as every other address registry in this file.
 */
export const FOREIGN_DEBRIDGE_EXECUTOR_ADDRESS: Record<string, string | null> = {
  "eth-mainnet": null,
  "polygon-mainnet": null,
  "arb-mainnet": null,
  "base-mainnet": null,
  "opt-mainnet": null,
};

export function foreignDeBridgeExecutorAddress(chainSlug: string): string | null {
  return FOREIGN_DEBRIDGE_EXECUTOR_ADDRESS[chainSlug] ?? null;
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
