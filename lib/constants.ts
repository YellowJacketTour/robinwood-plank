// $PLANK token contract. The RobinWood NFT mint contract is defined separately
// in lib/mint-contract.ts.
/** Official $PLANK token contract — never swap against any other address. */
export const CONTRACT_ADDRESS = "0x69420eaf0eBF43E08F621B014f25cEfDfA7e2DDc";

export const SITE_URL = "https://plank.love";

/**
 * DEV-ONLY: when NEXT_PUBLIC_DEV_LOCAL_CHAIN=1, the whole app talks to a local
 * Hardhat node (chainId 31337) instead of Robinhood Chain, so the V3 vault can
 * be deployed and exercised end-to-end without any mainnet. Unset in production;
 * scripts/local-v3-setup.ts prints the .env.local this expects.
 */
const DEV_LOCAL_CHAIN = process.env.NEXT_PUBLIC_DEV_LOCAL_CHAIN === "1";

/** Robinhood Chain (primary public Uniswap AMM); a local Hardhat node in dev. */
export const CHAIN = DEV_LOCAL_CHAIN
  ? ({
      id: 31337,
      name: "Localhost (V3 dev)",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: process.env.NEXT_PUBLIC_DEV_LOCAL_RPC || "http://127.0.0.1:8545" },
      blockExplorers: { default: { name: "Local node", url: "http://127.0.0.1:8545" } },
      uniswapSlug: "robinhood",
    } as const)
  : ({
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
    } as const);

/**
 * RPC URL the browser read-provider should use — always the same-origin
 * `/api/rpc` proxy, never the node directly. Both chains have a CORS problem
 * that blocks direct browser reads: the public Robinhood RPC sends a malformed
 * duplicate `Access-Control-Allow-Origin: *,*` header, and the local dev node's
 * preflight omits POST. The proxy does the request server-side (where CORS does
 * not apply) and is dev-aware via CLIENT_PROXY_RPC_URLS. `CHAIN.rpcUrls.default`
 * stays the real node URL — that is what wallet_addEthereumChain seeds into
 * MetaMask, and the wallet talks to the node directly, not subject to page CORS.
 * Relative here; the read layer resolves it against window.origin.
 */
export const READ_RPC_URL = "/api/rpc";

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
 * Phase B: gasless swaps via UniswapX (Dutch auction, filler pays gas).
 * UniswapX is live on Robinhood Chain (chain 4663) via the DutchV3OrderReactor
 * — confirmed against current Uniswap Trading API docs 2026-07-30.
 *
 * HARD OFF by default. Same on/off-without-deploy pattern as TRADE_PAUSED /
 * MARKET_ENABLED: this is read identically on the server (gates whether
 * /api/uniswap/quote will ever include UNISWAPX_V3 in `protocols`, and
 * whether /api/uniswap/order accepts submissions at all) and on the client
 * (gates whether the gasless toggle renders). The server check is what
 * actually matters for safety — the client flag only controls whether the
 * UI offers the option.
 */
export const GASLESS_SWAPS_ENABLED =
  process.env.NEXT_PUBLIC_GASLESS_ENABLED?.trim().toLowerCase() === "true";

/**
 * UniswapX DutchV3OrderReactor on Robinhood Chain — the only contract that
 * may appear as the `reactor` on an order our server will let a client sign.
 * A tampered/substituted reactor address is exactly the shape of attack that
 * would redirect a "gasless swap" into an arbitrary contract instead of the
 * real UniswapX settlement flow.
 * @see https://developers.uniswap.org/docs/trading/swapping-api/supported-chains
 */
export const UNISWAPX_REACTOR_ADDRESS =
  "0x000000007A1C8e570011eEDF86A2A35593013cBA" as const;

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

/**
 * The address the $PLANK constructor minted 100% of the supply to, and the
 * address it then handed ownership to. Hard-coded in the deployed, verified
 * token source itself:
 *
 *   address supplyRecipient = 0x6d05f45b602397eC1842395b2b465298BC36e5fB;
 *   _mint(supplyRecipient, 8884200694208880 * (10 ** decimals()) / 10);
 *   _transferOwnership(0x6d05f45b602397eC1842395b2b465298BC36e5fB);
 *
 * Verified on Robinhood Chain 2026-07-31. It is NOT a vesting, timelock, or
 * LP-lock contract — Blockscout reports it as an EOA carrying an EIP-7702
 * delegation to Alchemy's `SemiModularAccount7702`, i.e. a smart-account
 * wallet whose owner can move the balance at any time. That distinction is
 * the whole reason /trade shows an FDV and refuses to publish a "circulating
 * market cap": there is nothing locked here to honestly subtract.
 *
 * Used only to read a balance for disclosure. Never an allowlisted
 * destination, never a fee recipient.
 */
export const PLANK_SUPPLY_RECIPIENT =
  "0x6d05f45b602397eC1842395b2b465298BC36e5fB" as const;

/**
 * Conventional burn sink. $PLANK is `ERC20Burnable`, so supply can fall via a
 * real `burn()` (which lowers `totalSupply()` directly), but tokens are also
 * commonly "burned" by sending them here, where `totalSupply()` still counts
 * them. Both are read before any valuation figure is published — as of
 * 2026-07-31 both this address and the zero address hold exactly 0 $PLANK.
 */
export const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;

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
  { href: "/memes", label: "Memes" },
  { href: "/learn", label: "Learn" },
  // Airdrop intentionally removed from the nav (2026-07) to make room for
  // the WoodAmp music chip — the #airdrop section and its checker still
  // exist on the homepage; they're just not a top-level destination anymore.
] as const;

export const SOCIAL_LINKS = {
  twitter: "https://x.com/RobinWoodPlank",
  telegram: "https://t.me/PlankLove",
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
 * NFTX-style vault/AMM contract for the RobinWood collection. This one MUST
 * stay env-configurable (it is a real deploy output), but a malformed value
 * fails closed at module load instead of silently pointing every vault call
 * at garbage.
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
 * Primary Instant Swap vault — preferred for new deposits / LP. As of
 * 2026-08-01 this is MarketplankVaultV3 ("Premium Plank Liquidity"); V1
 * (Driftwood) and V2 (WormWood) are legacy, redeem-only (see
 * MARKET_VAULT_LEGACY_ADDRESSES below).
 */
export const MARKET_VAULT_ADDRESS: string | null = parseOptionalAddress(
  process.env.NEXT_PUBLIC_MARKET_VAULT_ADDRESS,
  "NEXT_PUBLIC_MARKET_VAULT_ADDRESS"
);

/**
 * Parse a comma-separated address list, validating each element. Blank entries
 * are skipped; a malformed entry fails closed at module load.
 */
function parseAddressList(raw: string | undefined, envName: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      throw new Error(`${envName} contains an invalid 20-byte address: "${v}"`);
    }
    out.push(v);
  }
  return out;
}

/**
 * Every legacy (redeem-only) vault that still holds pre-migration deposits.
 * Prefer the plural NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES (comma list) so a
 * third+ vault never needs new env plumbing; the singular
 * NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS is still read as a one-release
 * fallback. Deduped against the primary and each other, order preserved.
 *
 * NEVER drop a legacy until its vault reads empty — removing it bricks every
 * legacy call for its holders ("Blocked unsafe vault target").
 */
export const MARKET_VAULT_LEGACY_ADDRESSES: readonly string[] = (() => {
  const fromList = parseAddressList(
    process.env.NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES,
    "NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESSES"
  );
  const fromSingular = parseOptionalAddress(
    process.env.NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS,
    "NEXT_PUBLIC_MARKET_VAULT_LEGACY_ADDRESS"
  );
  const raw = fromList.length > 0 ? fromList : fromSingular ? [fromSingular] : [];
  const primary = MARKET_VAULT_ADDRESS?.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of raw) {
    const lc = a.toLowerCase();
    if (lc === primary || seen.has(lc)) continue;
    seen.add(lc);
    out.push(a);
  }
  return out;
})();

/**
 * Back-compat: the first legacy vault. Existing single-legacy consumers keep
 * working; new code that must enumerate ALL legacies uses the plural above.
 */
export const MARKET_VAULT_LEGACY_ADDRESS: string | null =
  MARKET_VAULT_LEGACY_ADDRESSES[0] ?? null;

/**
 * Known production vault addresses (Robinhood), used for generation labels and
 * as hard fallbacks so the client never "forgets" where historic deposits live.
 * Env-overridable so the local dev stack can stand up its own V1/V2 vaults and
 * have the registry label them correctly (dev-only; prod uses the literals).
 */
export const MARKET_VAULT_V1_KNOWN =
  process.env.NEXT_PUBLIC_MARKET_VAULT_V1_KNOWN || "0xb2019Fd4cA24502e812C0C73b751Fa49979BF708";
export const MARKET_VAULT_V2_KNOWN =
  process.env.NEXT_PUBLIC_MARKET_VAULT_V2_KNOWN || "0xc4B29D7a01603D2A5937b1FC86ea85E488d72e04";

/** Every vault address the UI/wallet may talk to (primary + all legacies). */
export const MARKET_VAULT_ADDRESSES: readonly string[] = (() => {
  const out: string[] = [];
  if (MARKET_VAULT_ADDRESS) out.push(MARKET_VAULT_ADDRESS);
  out.push(...MARKET_VAULT_LEGACY_ADDRESSES);
  return out;
})();

/** True when more than one vault is configured (primary + >=1 legacy). */
export const MARKET_VAULT_DUAL_MODE = MARKET_VAULT_ADDRESSES.length > 1;

/** The vault's own DrandBeacon — read live from the deployed vault's
 * beacon() getter, not guessed or copied from a deploy script that could
 * drift. Lives here (not lib/market/drand.ts) so lib/wallet.ts's
 * destination allowlist and lib/market/drand.ts's send helper can both
 * import it without importing each other. */
export const DRAND_BEACON_ADDRESS =
  process.env.NEXT_PUBLIC_DRAND_BEACON_ADDRESS || "0x87d584df130FED0Fe540954eD48CE2691A18D619";

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
 * Marketplank's own fee on a NATIVE listing/offer created directly on a
 * foreign EVM chain (baked into the order's own consideration array at
 * listing time via seaport.ts's feesFor(), the same mechanism Robinhood
 * Chain's own listings already use) -- NOT the same knob as
 * MARKET_DEFAULT_FEE_BPS above, which stays 50/0.5% for Robinhood-chain
 * collections with no explicit override. Set to undercut OpenSea's ~2.5%
 * protocol fee, which is otherwise baked into every third-party listing
 * this app displays/fulfills on those same chains and cannot be reduced
 * (it's embedded in the seller's own signed order).
 *
 * NOTE: lib/market/multichain/trading/foreign-chain-registry.ts's
 * FOREIGN_FEE_BPS is ALSO 180 -- a different mechanism entirely, a
 * UI-display estimate for MarketplankForeignFeeRouter.sol's constructor
 * argument (an undeployed, unrelated contract that would skim a fee at
 * fulfillment time on top of a THIRD-PARTY OpenSea order). Do not import or
 * alias one from the other -- they encode the same business decision (half
 * of OpenSea's ~2.5%) independently for two unrelated fee-charging
 * mechanisms, and must be free to diverge later without any coupling.
 */
export const MARKETPLANK_NATIVE_LISTING_FEE_BPS = 180; // 1.8%

/**
 * Swap/OTC listings (NFT-for-NFT, NFT+coin, any combination -- see
 * lib/market/order-validation.ts's validateSwapOrder). Same 1.8% as
 * MARKETPLANK_NATIVE_LISTING_FEE_BPS, applied to whichever side of the
 * trade carries a native-ETH amount (there is always at least one,
 * enforced by the flat-fee fallback below for a pure barter swap with
 * neither side including ETH). Kept as its own constant, not aliased --
 * same reasoning as every other fee constant in this file: free to diverge
 * later without coupling two unrelated decisions.
 */
export const MARKETPLANK_SWAP_FEE_BPS = 180; // 1.8%

/**
 * A pure barter swap (no ETH on either side) has no monetary total a
 * percentage fee could apply to -- this flat wei amount is charged instead,
 * as a required consideration item to MARKET_FEE_RECIPIENT, so the feature
 * is never revenue-free regardless of trade shape. Set low enough not to
 * block a genuine 1-for-1 collectible swap between two real collections
 * (roughly $1-2 in ETH at typical prices -- reviewed, not derived from a
 * live price feed, since this is a flat anti-zero-revenue floor, not a
 * market-priced fee).
 */
export const MARKETPLANK_SWAP_FLAT_FEE_WEI = "500000000000000"; // 0.0005 ETH

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
    PLANK_SUPPLY_RECIPIENT,
    BURN_ADDRESS,
    NATIVE_TOKEN_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    UNISWAPX_REACTOR_ADDRESS,
    PERMIT2_ADDRESS,
    "SITE_FEE.recipient": SITE_FEE.recipient,
    SEAPORT_ADDRESS,
    CONDUIT_CONTROLLER_ADDRESS,
    MARKET_FEE_RECIPIENT,
    MARKET_OFFER_CURRENCY,
    ...(MARKET_VAULT_ADDRESS ? { MARKET_VAULT_ADDRESS } : {}),
    ...Object.fromEntries(
      MARKET_VAULT_LEGACY_ADDRESSES.map((a, i) => [`MARKET_VAULT_LEGACY_ADDRESS_${i}`, a])
    ),
  });

for (const [name, value] of Object.entries(EXPORTED_ADDRESS_CONSTANTS)) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `Address constant ${name} is malformed ("${value}", ${value.length} chars) — refusing to start with a broken address allowlist.`
    );
  }
}
