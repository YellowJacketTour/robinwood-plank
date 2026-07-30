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
      // Verified 2026-07-27: https://explorer.mainnet.chain.robinhood.com is a
      // 3xx redirect to this Blockscout host. wallet_addEthereumChain seeds
      // this URL permanently into users' wallets, so store the canonical
      // final host, not a redirect that can rot.
      url: "https://robinhoodchain.blockscout.com",
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
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

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
 * Primary navigation in reading order. `emphasis` changes presentation only;
 * every destination still comes from this single source of truth.
 */
export const NAV_LINKS = [
  { href: "/market", label: "Market" },
  { href: "/trade", label: "Trade", emphasis: "cta" },
  { href: "#mint", label: "Mint", activePaths: ["/mint", "/launch"] },
  { href: "/gallery", label: "Gallery" },
  { href: "/learn", label: "Learn" },
  { href: "#airdrop", label: "Airdrop" },
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
// HARD-CODED ON PURPOSE (audit 2026-07-27): this was previously overridable
// via NEXT_PUBLIC_SEAPORT_ADDRESS, which meant one wrong env var silently
// repointed every order + every approval at an arbitrary contract. The
// canonical CREATE2 address never changes per-chain, so there is no
// legitimate reason for it to be configurable.
export const SEAPORT_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";

/**
 * Seaport's ConduitController — same deterministic-deployment story as
 * Seaport itself. Confirmed live and verified on Robinhood Chain alongside it.
 */
// Hard-coded for the same reason as SEAPORT_ADDRESS above.
export const CONDUIT_CONTROLLER_ADDRESS = "0x00000000F9490004C11Cef243f5400493c00Ad63";

/**
 * NFTX-style vault/AMM contract for the RobinWood collection — unset until
 * deployed. This one MUST stay env-configurable (it is a real deploy output),
 * but a malformed value fails closed at module load instead of silently
 * pointing every vault call at garbage.
 */
function parseOptionalAddress(raw: string | undefined, envName: string): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new Error(`${envName} is set but is not a valid 20-byte address: "${v}"`);
  }
  return v;
}

/**
 * Primary Instant Swap vault — preferred for new deposits / LP after a V2
 * migrate. Until V2 is deployed this is the live V1 address.
 */
export const MARKET_VAULT_ADDRESS: string | null = parseOptionalAddress(
  process.env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS,
  "NEXT_PUBLIC_MARKET_VAULT_ADDRESS"
);

/**
 * Legacy vault that still holds pre-migrate deposits. Keep this set to V1
 * when PRIMARY points at a new vault so holders can redeem without being
 * stranded. Optional: null means single-vault mode.
 */
export const MARKET_VAULT_LEGACY_ADDRESS: string | null = (() => {
  const legacy = parseOptionalAddress(
    process.env.NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS,
    "NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS"
  );
  if (!legacy || !MARKET_VAULT_ADDRESS) return legacy;
  if (legacy.toLowerCase() === MARKET_VAULT_ADDRESS.toLowerCase()) return null;
  return legacy;
})();

/**
 * Known production V1 vault (Robinhood). Used for migration copy and as a
 * hard fallback label so we never "forget" where the first 57 deposits live.
 */
export const MARKET_VAULT_V1_KNOWN = "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708" as const;

/** Every vault address the UI/wallet may talk to (primary + legacy). */
export const MARKET_VAULT_ADDRESSES: readonly string[] = (() => {
  const out: string[] = [];
  if (MARKET_VAULT_ADDRESS) out.push(MARKET_VAULT_ADDRESS);
  if (MARKET_VAULT_LEGACY_ADDRESS) out.push(MARKET_VAULT_LEGACY_ADDRESS);
  return out;
})();

/** True when primary and legacy are both set and different. */
export const MARKET_VAULT_DUAL_MODE =
  MARKET_VAULT_ADDRESS !== null && MARKET_VAULT_LEGACY_ADDRESS !== null;

/** The vault's own DrandBeacon — read live from the deployed vault's
 * beacon() getter, not guessed or copied from a deploy script that could
 * drift. Lives here (not lib/market/drand.ts) so lib/wallet.ts's
 * destination allowlist and lib/market/drand.ts's send helper can both
 * import it without importing each other. */
export const DRAND_BEACON_ADDRESS = "0x87d584df130FED0Fe540954eD48CE2691A18D619";

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
 * WETH on Robinhood Chain — the currency all offers/bids are denominated in.
 *
 * Seaport cannot pull native ETH from an offerer at fulfillment time, so a bid
 * has to be made in an ERC-20. Our offer flow originally used native ETH,
 * which could never have filled; this address is the fix.
 *
 * HARD-CODED ON PURPOSE. Verified 2026-07-27 by direct RPC call:
 * symbol() = "WETH", decimals() = 18, verified proxy over Arbitrum's aeWETH.
 * At least three impostor contracts on this chain also report the symbol
 * "WETH" (one with zero supply, one unverified, one an LP token), so this must
 * never be resolved by symbol lookup or off-chain search.
 */
export const MARKET_OFFER_CURRENCY = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

/**
 * STARTUP ASSERTION (audit 2026-07-27, AUDIT-1): PERMIT2_ADDRESS shipped with
 * a truncated 39-hex-char literal, which made the swap approval allowlist
 * unmatchable and killed every $PLANK sell. TypeScript cannot catch a
 * one-character-short address string, so every exported address constant is
 * shape-checked once at module load. Throwing here fails the build / first
 * render loudly instead of failing silently at the wallet boundary.
 */
export const EXPORTED_ADDRESS_CONSTANTS: Readonly<Record<string, string>> =
  Object.freeze({
    CONTRACT_ADDRESS,
    NATIVE_TOKEN_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    PERMIT2_ADDRESS,
    "SITE_FEE.recipient": SITE_FEE.recipient,
    SEAPORT_ADDRESS,
    CONDUIT_CONTROLLER_ADDRESS,
    MARKET_FEE_RECIPIENT,
    MARKET_OFFER_CURRENCY,
    ...(MARKET_VAULT_ADDRESS ? { MARKET_VAULT_ADDRESS } : {}),
    ...(MARKET_VAULT_LEGACY_ADDRESS ? { MARKET_VAULT_LEGACY_ADDRESS } : {}),
  });

for (const [name, value] of Object.entries(EXPORTED_ADDRESS_CONSTANTS)) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `Address constant ${name} is malformed ("${value}", ${value.length} chars) — refusing to start with a broken address allowlist.`
    );
  }
}
