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
 * Community trade open time (ISO 8601).
 * Override at deploy with NEXT_PUBLIC_TRADE_OPENS_AT.
 * Until this moment the on-site Uniswap widget is hard-locked.
 * LP may go live ~30 minutes earlier as a bot sniper trap — community waits for this timer.
 *
 * Default: 2026-07-25 4:20 PM America/Chicago (CDT) → 21:20 UTC
 */
export const TRADE_OPENS_AT_ISO =
  process.env.NEXT_PUBLIC_TRADE_OPENS_AT?.trim() || "2026-07-25T21:20:00.000Z";

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
 * 0.42069% = 42.069 basis points (Uniswap supports fractional bps to 2 decimals).
 *
 * IMMUTABLE by design:
 * - Hard-coded (not from env / not from client body)
 * - Server always re-injects this on /api/uniswap/quote
 * - Client cannot override bps or recipient (rejected by assertNoClientFeeOrRouteOverride)
 * Requires UNISWAP_API_KEY + Universal Router 2.1.1 (set on server quotes).
 */
export const SITE_FEE = Object.freeze({
  /** Human-readable percent, e.g. 0.42069 */
  percent: 0.42069,
  /** Basis points sent to Uniswap `integratorFee.bps` */
  bps: 42.069,
  /** Display string for UI */
  label: "0.42069%",
  /** Treasury wallet that receives the fee on Robinhood Chain */
  recipient: "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba",
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
export const NAV_LINKS = [
  { href: "#mint", label: "Mint" },
  { href: "/gallery", label: "Gallery" },
  { href: "#collection", label: "Collection" },
  { href: "#tokenomics", label: "Funding" },
  { href: "#roadmap", label: "Roadmap" },
  { href: "#get-ready", label: "Guide" },
] as const;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/RobinWoodPlank",
} as const;

// Official Wood List thread — drop your wallet address in the replies.
export const WOOD_LIST_TWEET_URL =
  "https://x.com/RobinWoodPlank/status/2079327510458982752";
