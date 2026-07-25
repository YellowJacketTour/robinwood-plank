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
/**
 * Widget integrator fee (Uniswap Trading API).
 *
 * EMERGENCY: bps=0 — fee path was taking complexity (extra UR commands) and
 * buys were reverting / under-gassing while users lost gas and saw no $PLANK.
 * On-chain: fee treasury had 0 PLANK fee transfers while UR buys failed.
 * Set bps back to 42.07 only after fee-route swaps are proven on RH.
 */
export const SITE_FEE = Object.freeze({
  /** Human-readable percent charged (matches bips) */
  percent: 0,
  /**
   * IntegratorFee.bips (1 bip = 0.01%). Max 2 decimal places per Uniswap API.
   * 0 = no fee (full output to buyer). Was 42.07 (= 0.4207%).
   */
  bps: 0,
  /** Display string for UI */
  label: "0%",
  /** Treasury wallet (unused while bps=0) */
  recipient: "0xfa987d386c4f61b27cb67a1e4e1239866fe8d9ba",
  /** When false, server omits integratorFees entirely from Uniswap quote */
  enabled: false,
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
] as const;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/RobinWoodPlank",
} as const;

// Official Wood List thread — drop your wallet address in the replies.
export const WOOD_LIST_TWEET_URL =
  "https://x.com/RobinWoodPlank/status/2079327510458982752";
