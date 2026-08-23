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
 * ZKSYNC: NATIVE TRADING YES, OPENSEA ORDERBOOK NO
 * ---------------------------------------------------------
 * Confirmed live 2026-08-17: OpenSea's API returns
 * {"errors":["Unrecognized chain: zksync"]} for every slug spelling tried
 * (zksync, zksync-era, zksync_era) -- there is still no confirmed free/real
 * OpenSea order-sourcing path for it. That USED to mean zkSync was excluded
 * from this whole registry, blocking Marketplank's OWN native listings too
 * even though native trading never touches OpenSea's API at all -- it's
 * this app's own signed Seaport orders, stored and served without any
 * third party. Flagged live 2026-08-19 ("as inclusive as possible unifying
 * our project scope"): that was an unnecessary coupling, not a real
 * requirement. Fixed by making `openSeaChain` nullable (see the type's own
 * doc comment) -- zkSync now has a real FOREIGN_CHAINS entry with
 * openSeaChain: null, native listings/offers/bundles work there exactly
 * like every other foreign chain, and every OpenSea-orderbook consumer of
 * this registry (foreign-orders.ts, foreign-offer.ts, the multichain
 * listings/offers/activity/my-listings/wallet-summary API routes,
 * opensea-bulk-scan.ts, rarity-index-runner.ts) treats a null
 * openSeaChain as "skip OpenSea for this chain" and degrades to an
 * empty/native-only result rather than calling OpenSea with a chain slug
 * it has already confirmed it doesn't recognize.
 *
 * THE CROSS-CHAIN ROUTER PATH -- STILL FUTURE WORK, UNCHANGED BY THIS
 * -----------------------------------------------------------------
 * None of MarketplankForeignFeeRouter.sol, MarketplankAcrossReceiver.sol,
 * or MarketplankDeBridgeExecutor.sol contain ANY chain-specific logic --
 * every chain identity (Seaport address, wrapped-native-token address,
 * SpokePool/adapter address) is a constructor argument, not a hardcoded
 * constant. None of them are deployed to zkSync yet (every
 * FOREIGN_FEE_ROUTER_ADDRESS/etc. entry for it is null below, same as
 * every other chain -- these contracts are undeployed everywhere, out of
 * scope for this pass), and doing so needs a real zkSync-specific compile
 * (zksolc, not vanilla solc) + deploy + verify pass of its own, not just an
 * address added to a registry.
 */

import { ALCHEMY_NETWORK_SUBDOMAIN, apiKey } from "@/lib/market/multichain/adapters/alchemy-network";

export type ForeignChainConfig = {
  /** Matches lib/market/multichain's chainSlug convention (e.g. alchemy-nft.ts). */
  chainSlug: string;
  chainId: number;
  /**
   * OpenSea's own chain identifier for this chain -- confirmed live, NOT
   * always the obvious name (Polygon is "matic", BNB Chain is "bsc").
   * NULL for a chain with no confirmed OpenSea order-sourcing path (zkSync
   * today -- see its own FOREIGN_CHAINS entry). Every call site that reads
   * this field MUST treat null as "skip OpenSea for this chain, real
   * orders just don't come from there" and degrade to an empty/partial
   * result, never throw -- Marketplank's OWN native listings (this app's
   * signed Seaport orders, stored and served without OpenSea at all) are
   * unaffected either way, since that pathway never reads this field.
   */
  openSeaChain: string | null;
  /** Real native gas-token symbol -- NOT "ETH" for every chain (Polygon's is POL/MATIC, BNB Chain's is BNB, Avalanche's is AVAX). Used for wallet_addEthereumChain's nativeCurrency field. */
  nativeCurrencySymbol: string;
  /** Real block explorer origin, for wallet_addEthereumChain's blockExplorerUrls. */
  blockExplorerUrl: string;
};

/**
 * Robinhood Chain (4663) is intentionally absent -- its trading path is
 * lib/market/seaport.ts + lib/constants.ts, unaffected by this file.
 */
export const FOREIGN_CHAINS: ForeignChainConfig[] = [
  { chainSlug: "eth-mainnet", chainId: 1, openSeaChain: "ethereum", nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://etherscan.io" },
  { chainSlug: "polygon-mainnet", chainId: 137, openSeaChain: "matic", nativeCurrencySymbol: "POL", blockExplorerUrl: "https://polygonscan.com" },
  { chainSlug: "arb-mainnet", chainId: 42161, openSeaChain: "arbitrum", nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://arbiscan.io" },
  { chainSlug: "base-mainnet", chainId: 8453, openSeaChain: "base", nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://basescan.org" },
  { chainSlug: "opt-mainnet", chainId: 10, openSeaChain: "optimism", nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://optimistic.etherscan.io" },
  { chainSlug: "bnb-mainnet", chainId: 56, openSeaChain: "bsc", nativeCurrencySymbol: "BNB", blockExplorerUrl: "https://bscscan.com" },
  { chainSlug: "avax-mainnet", chainId: 43114, openSeaChain: "avalanche", nativeCurrencySymbol: "AVAX", blockExplorerUrl: "https://snowtrace.io" },
  // zkSync Era -- native trading only (openSeaChain: null), see this
  // file's own header ("ZKSYNC IS DELIBERATELY EXCLUDED" section, now
  // superseded: it's included for Marketplank-native listings, which never
  // read openSeaChain, while every OpenSea-orderbook consumer of this
  // registry treats null as "no orders from there" and degrades cleanly).
  // Confirmed live 2026-08-19: real Seaport bytecode + name() returning
  // "Seaport" at the canonical address on chainId 324 via Alchemy's
  // zksync-mainnet RPC (already in ALCHEMY_NETWORK_SUBDOMAIN).
  { chainSlug: "zksync-mainnet", chainId: 324, openSeaChain: null, nativeCurrencySymbol: "ETH", blockExplorerUrl: "https://explorer.zksync.io" },
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
export function nativeCurrencySymbol(chainSlug: string, isSolana: boolean, isBitcoin = false): string {
  if (isSolana) return "SOL";
  if (isBitcoin) return "BTC";
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
  // Confirmed live 2026-08-19 via eth_call name() -> "Wrapped Ether".
  "zksync-mainnet": "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
};

export function foreignOfferCurrency(chainSlug: string): string | null {
  return FOREIGN_OFFER_CURRENCY[chainSlug] ?? null;
}

/**
 * DEV-ONLY: when NEXT_PUBLIC_FOREIGN_DEV_RPC_OVERRIDE is set, EVERY foreign
 * chain's RPC resolves to this one URL instead of real Alchemy -- for
 * pointing the whole native-listing feature at a LOCAL FORK (npx hardhat
 * node --fork <real RPC> --chain-id <real chainId> --port <port>) for
 * completely free, unlimited local testing. The fork's own --chain-id MUST
 * still equal the REAL chain's id (e.g. 8453 for Base) -- Seaport
 * recomputes its EIP-712 domain from block.chainid, so a mismatched fork
 * chainId makes every real signature fail InvalidSigner() even though the
 * order and signature are both genuinely valid (confirmed live this
 * session's own fork-proof script). This is why the override changes ONLY
 * the RPC host, unlike Robinhood Chain's own NEXT_PUBLIC_DEV_LOCAL_CHAIN in
 * lib/constants.ts, which also swaps the chainId to 31337 -- that pattern
 * would break signature verification here. Same env var read on client and
 * server (NEXT_PUBLIC_ prefix reaches both); unset in production.
 */
const FOREIGN_DEV_RPC_OVERRIDE = process.env.NEXT_PUBLIC_FOREIGN_DEV_RPC_OVERRIDE?.trim();

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
/**
 * Real, free, no-key public RPC fallback per chain -- PublicNode
 * (publicnode.com), added live 2026-08-20 in direct response to
 * Alchemy's own key hitting its real monthly capacity limit
 * ("eth_blockNumber: Monthly capacity limit exceeded") and blocking
 * every EVM chain this app trades on at once, confirmed live this
 * session. Alchemy stays FIRST in foreignRpcUrls's returned array on
 * purpose -- this is redundancy, not a replacement (Alchemy's
 * NFT-metadata API is used elsewhere in this app independently of raw
 * RPC, and its free tier resets monthly). PublicNode's own real,
 * documented URL scheme is `{network}-rpc.publicnode.com`; every chain
 * below was checked against that exact pattern. A chain with no known
 * PublicNode endpoint yet stays Alchemy-only rather than guessing a URL.
 */
const PUBLICNODE_FALLBACK: Record<string, string> = {
  "eth-mainnet": "https://ethereum-rpc.publicnode.com",
  "arb-mainnet": "https://arbitrum-one-rpc.publicnode.com",
  "base-mainnet": "https://base-rpc.publicnode.com",
  "opt-mainnet": "https://optimism-rpc.publicnode.com",
  "bnb-mainnet": "https://bsc-rpc.publicnode.com",
  "avax-mainnet": "https://avalanche-c-chain-rpc.publicnode.com",
};

/**
 * Chain-operated public endpoints are a last-resort safety net. Their own
 * operators describe them as rate-limited public infrastructure, so they are
 * deliberately behind both Alchemy and PublicNode and must never be treated
 * as an "unlimited" production entitlement.
 */
const FOUNDATION_RPC_FALLBACK: Record<string, string> = {
  "arb-mainnet": "https://arb1.arbitrum.io/rpc",
  "base-mainnet": "https://mainnet.base.org",
  "opt-mainnet": "https://mainnet.optimism.io",
  "bnb-mainnet": "https://bsc-dataseed.bnbchain.org",
  "avax-mainnet": "https://api.avax.network/ext/bc/C/rpc",
  "zksync-mainnet": "https://mainnet.era.zksync.io",
};

export type ForeignRpcEndpoint = {
  id: string;
  url: string;
  kind: "keyed" | "configured" | "public-aggregator" | "chain-public" | "development";
  /** Public endpoints commonly restrict historical eth_getLogs. */
  archiveLogs: "supported" | "restricted" | "unknown";
};

function configuredRpcEndpoints(chainSlug: string): ForeignRpcEndpoint[] {
  // Operators can add independent Ankr/Infura/dRPC/Chainstack/etc accounts
  // without a deployment-time code change. Server-only by design: URLs often
  // contain credentials. Example: RPC_URLS_BASE_MAINNET=url1,url2.
  const envKey = `RPC_URLS_${chainSlug.replace(/-/g, "_").toUpperCase()}`;
  return (process.env[envKey] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//.test(url))
    .map((url, index) => ({
      id: `configured-${index + 1}`,
      url,
      kind: "configured" as const,
      archiveLogs: "unknown" as const,
    }));
}

export function foreignRpcEndpoints(chainSlug: string): ForeignRpcEndpoint[] {
  if (FOREIGN_DEV_RPC_OVERRIDE) {
    return [{ id: "development", url: FOREIGN_DEV_RPC_OVERRIDE, kind: "development", archiveLogs: "unknown" }];
  }
  const subdomain = ALCHEMY_NETWORK_SUBDOMAIN[chainSlug];
  if (!subdomain) {
    throw new Error(`foreign-chain-registry: no Alchemy RPC mapping for chainSlug "${chainSlug}"`);
  }
  const endpoints: ForeignRpcEndpoint[] = [{
    id: "alchemy",
    url: `https://${subdomain}.g.alchemy.com/v2/${apiKey()}`,
    kind: "keyed",
    archiveLogs: "supported",
  }];
  endpoints.push(...configuredRpcEndpoints(chainSlug));
  const publicNode = PUBLICNODE_FALLBACK[chainSlug];
  if (publicNode) endpoints.push({ id: "publicnode", url: publicNode, kind: "public-aggregator", archiveLogs: "restricted" });
  const foundation = FOUNDATION_RPC_FALLBACK[chainSlug];
  if (foundation) endpoints.push({ id: "chain-public", url: foundation, kind: "chain-public", archiveLogs: "restricted" });
  return endpoints;
}

export function foreignRpcUrls(chainSlug: string): string[] {
  return foreignRpcEndpoints(chainSlug).map((endpoint) => endpoint.url);
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
 * NO LONGER USED BY BUY/SWEEP AS OF 2026-08-19 -- AND THE OLD SAFETY CLAIM
 * HERE WAS FACTUALLY WRONG
 * -------------------------------------------------------------------------
 * This block used to assert that "a chain with a null address here MUST NOT
 * be offered a Buy/Sweep affordance -- see isCrossChainBuyable() ... which
 * fail[s] closed (View-only)". That was NOT true: isCrossChainBuyable()
 * (lib/market/types.ts) only ever checked venue + foreignChainSlug +
 * foreignOrderHash and never consulted this map at all. The real
 * consequence, confirmed by reading the call sites (ListingCard.tsx,
 * BuyConfirm.tsx, MultichainCollectionView.tsx): users WERE shown a Buy
 * button on third-party foreign-chain listings, and clicking it always hit
 * requireRouter()'s hard "not yet deployed" throw. A genuinely broken,
 * user-facing feature, papered over by a comment claiming a guard that did
 * not exist.
 *
 * Fixed by removing the router from that path entirely: buy/sweep now
 * fulfill directly against Seaport's own canonical deployment (present on
 * every chain) with a fulfiller-side tip for the marketplace fee -- see
 * foreign-fulfill.ts's header and MARKETPLANK_FOREIGN_FILL_TIP_BPS in
 * lib/constants.ts. Nothing reads this map anymore.
 *
 * Kept (rather than deleted) because the contract source still exists and a
 * future deployment could still want it -- e.g. to capture a fee
 * cryptographically on-chain rather than via a client-supplied tip. If that
 * ever happens, fill in a real address ONLY after a real deployment +
 * verification on that specific chain; never guess or pre-populate one.
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
 * support -- that path fulfills straight against Seaport now (see
 * FOREIGN_FEE_ROUTER_ADDRESS's own header on why the router is no longer
 * involved) and needs no deployment on any chain, so it is unaffected by
 * Across's absence. Only the pay-from-any-chain Across path can never
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
