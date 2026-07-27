// $PLANK token contract. The RobinWood NFT mint contract is defined separately
// in lib/mint-contract.ts.
/** Official $PLANK token contract — never swap against any other address. */
export const CONTRACT_ADDRESS = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";

export const SITE_URL = "https://plank.love";

/** Robinhood Chain (primary public Uniswap AMM). */
export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: "https://rpc.mainnet.chain.robinhood.com",
  },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Explorer",
      url: "https://explorer.mainnet.chain.robinhood.com",
    },
  },
  /** Uniswap app chain slug used in custom interface links. */
  uniswapSlug: "robinhood",
} as const;

/** Native ETH sentinel used by the Uniswap Trading API. */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Uniswap Universal Router 2.1.1 on Robinhood Chain (chain 4663).
 * Widget only ever sends swap txs to this address — never bridges / never L1.
 * @see https://developers.uniswap.org/docs/trading/swapping-api/supported-chains
 */
export const UNIVERSAL_ROUTER_ADDRESS =
  "0x8876789976dEcBfCbBbe364623C63652db8C0904" as const;

/**
 * Canonical Permit2 contract address — identical across every chain Uniswap
 * deploys it to (deterministic CREATE2 deployment). Sell approvals may only
 * target this address or the $PLANK contract itself — nothing else.
 */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA" as const;

/** ETH (wei) buyers must keep free for gas after the buy amount. */
export const BUY_GAS_RESERVE_WEI = BigInt("4000000000000000"); // 0.004 ETH

/** Human label for the gas reserve. */
export const BUY_GAS_RESERVE_ETH = "0.004";

/**
 * Community trade open time (ISO 8601).
 * Override at deploy with NEXT_PUBLIC_TRADE_OPENS_AT.
 * Until this moment the on-site Uniswap widget is hard-locked.
 * LP may go live ~30 minutes earlier as a bot sniper trap — community waits for this timer.
 *
 * Default: 2026-07-25 4:20 PM America/Chicago (CDT) → 21:20 UTC
 */
export const TRADE_OPENS_AT_ISO =
  process.env.NEXT_PUBLIC_TRADE_OPENS_AT?.trim() || "2026-07-25T21:20:00.000Z";

/**
 * Hard pause: widget stays locked + countdown shows STAND BY.
 * Trading is live when this is false.
 *
 * Default: open (false). Set NEXT_PUBLIC_TRADE_PAUSED=true to pause again.
 */
export const TRADE_PAUSED =
  process.env.NEXT_PUBLIC_TRADE_PAUSED?.trim().toLowerCase() === "true";

/** How long before the community timer LP is expected live (sniper trap window). */
export const SNIPER_TRAP_MINUTES = 30;

/**
 * When false (default / launch phase): the ONLY safe place to trade $PLANK is this
 * site's official widget. No deep-links to Uniswap.app or other UIs — early / off-site
 * swaps risk the Plank List, limits, or fake pairs.
 *
 * Set NEXT_PUBLIC_RULES_RELAXED=true only after cooldowns/limits are off and LP is renounced.
 */
export const RULES_RELAXED =
  process.env.NEXT_PUBLIC_RULES_RELAXED?.trim().toLowerCase() === "true";

/**
 * plank.love integrator fee on in-widget Uniswap swaps (Trading API path only).
 *
 * Target meme rate was 0.42069%. Uniswap Trading API IntegratorFee.bips allows
 * at most 2 decimal places, so we send 42.07 bips (= 0.4207%) — closest legal value.
 *
 * IMMUTABLE by design:
 * - Hard-coded (not from env / not from client body)
 * - Server always re-injects this on /api/uniswap/quote as integratorFees: [{ bips, recipient }]
 * - Client cannot override (rejected by assertNoClientFeeOrRouteOverride)
 * Requires UNISWAP_API_KEY + Universal Router 2.1.1 (set on server quotes).
 */
export const SITE_FEE = Object.freeze({
  /** Human-readable percent charged (matches bips) */
  percent: 0.4207,
  /**
   * IntegratorFee.bips (1 bip = 0.01%). Max 2 decimal places per Uniswap API.
   * 42.07 bips = 0.4207%
   */
  bps: 42.07,
  /** Display string for UI */
  label: "0.4207%",
  /** Treasury wallet that receives the fee on Robinhood Chain */
  recipient: "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba",
  /**
   * When false, server omits integratorFees entirely from the Uniswap quote
   * (full output to buyer, no fee transfer). Flip off fast if a fee-route
   * swap ever fails simulation in a way that isn't already caught pre-flight.
   */
  enabled: true,
});

export const TOKEN = {
  symbol: "PLANK",
  name: "RobinWood Plank",
  address: CONTRACT_ADDRESS,
  decimals: 18,
  chainId: CHAIN.id,
} as const;

/**
 * Primary nav text links. Logo → home. Trade is the gold CTA button (not listed here).
 */
/** Keep nav short — Trade is the gold CTA; rest are anchors. */
export const NAV_LINKS = [
  { href: "#trade", label: "Trade" },
  { href: "#mint", label: "Mint" },
  { href: "#boards", label: "Boards" },
  { href: "#airdrop", label: "Airdrop" },
  { href: "/gallery", label: "Gallery" },
  { href: "/market", label: "Market" },
] as const;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/RobinWoodPlank",
} as const;

// Official Wood List thread — drop your wallet address in the replies.
export const WOOD_LIST_TWEET_URL =
  "https://x.com/RobinWoodPlank/status/2079327510458982752";

/**
 * Marketplank — the on-site NFT marketplace. See docs/marketplank/SPEC.md.
 *
 * HARD OFF by default. This is not a soft "coming soon" banner — no order-relay
 * API, no listing/offer contract, and no vault contract exists yet. Do not flip
 * this true until every gate in SPEC.md §7 is satisfied, especially the
 * independent third-party audit. Until then every /market route renders
 * ComingSoonGate and nothing else.
 */
export const MARKET_ENABLED =
  process.env.NEXT_PUBLIC_MARKET_ENABLED?.trim().toLowerCase() === "true";

/**
 * Seaport 1.6's canonical CREATE2 deployment address — identical bytecode on
 * every EVM chain it's deployed to, byte-for-byte the same contract OpenSea,
 * Trail of Bits, and Code4rena audited. Confirmed live AND verified on
 * Robinhood Chain via Blockscout (is_contract, is_verified, name: "Seaport")
 * on 2026-07-27 — no deploy needed, this is an integration, not a fork.
 * @see https://github.com/ProjectOpenSea/seaport/blob/main/docs/Deployment.md
 */
export const SEAPORT_ADDRESS =
  process.env.NEXT_PUBLIC_SEAPORT_ADDRESS?.trim() ||
  "0x0000000000000068F116a894984e2DB1123eB395";

/**
 * Seaport's ConduitController — same deterministic-deployment story as
 * Seaport itself. Confirmed live and verified on Robinhood Chain alongside it.
 */
export const CONDUIT_CONTROLLER_ADDRESS =
  process.env.NEXT_PUBLIC_CONDUIT_CONTROLLER_ADDRESS?.trim() ||
  "0x00000000F9490004C11Cef243f5400493c00Ad63";

/** NFTX-style vault/AMM contract for the RobinWood collection — unset until deployed. */
export const MARKET_VAULT_ADDRESS: string | null =
  process.env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS?.trim() || null;

/** Seaport protocol version Marketplank targets. */
export const SEAPORT_VERSION = "1.6";

/**
 * Marketplank fee model:
 * - $PLANK / RobinWood trades: always 0% (see lib/market/collections.ts).
 * - Every other approved collection: this default unless toggled per-collection.
 * Fees accrue to MARKET_FEE_RECIPIENT in ETH — no new token, no seed capital
 * from the owner. Once that treasury holds enough, it funds the Phase 2
 * vault's seed liquidity. See docs/marketplank/SPEC.md §9.
 */
export const MARKET_DEFAULT_FEE_BPS = 50; // 0.5%

/**
 * Marketplank's dedicated treasury wallet — separate from SITE_FEE.recipient
 * (the Trade section's Uniswap integrator fee wallet). Every marketplace fee
 * and vault fee accrues here. Set 2026-07-27; keep this the single source of
 * truth for the address rather than hard-coding it elsewhere.
 */
export const MARKET_FEE_RECIPIENT = "0xcdb7ca36d35fa16d15fda859a46f1d72d979e9d8";

/**
 * ETH the fee treasury should hold before the Phase 2 vault is deployed and
 * seeded from it — sized so a ~0.5 ETH trade moves the pool price under
 * ~5% (constant-product AMMs move price roughly trade-size ÷ reserve-size,
 * so a 15-20x reserve keeps typical trades from swinging price hard).
 * Adjust freely; this is a starting estimate, not a hard-coded protocol rule.
 */
export const MARKET_VAULT_SEED_TARGET_ETH = 7.5;
