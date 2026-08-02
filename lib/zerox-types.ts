/**
 * Shared request/response contracts for the 0x integration
 * (app/api/zerox/* on the server, components/trade/ZeroX*.tsx on the client).
 *
 * AMOUNT DISCIPLINE: every amount crossing this boundary is a decimal string
 * in BASE UNITS (wei-scale), same convention as lib/uniswap-types.ts. Parse
 * with BigInt / lib/trade's parseTokenAmount — never Number()/parseFloat.
 */

export type SwapDirection = "buy" | "sell";

/**
 * Public fee metadata shape returned by lib/zerox-server.ts's
 * getPublicSiteFee(). `bps`/`label` are what 0x actually charges (floored to
 * an integer — 0x's swapFeeBps/feeBps params reject any decimal, confirmed
 * live); `exactBps`/`exactLabel` are the site-wide exact fee (0.4207%) for
 * comparison. `roundedDownFrom` is set only when the two differ, so the UI
 * can disclose "0x charges 0.42% instead of 0.4207%" instead of silently
 * showing the wrong number.
 */
export interface ZeroXPublicSiteFee {
  percent: number;
  bps: number;
  exactBps: number;
  label: string;
  exactLabel: string;
  recipient: string;
  enabled: boolean;
  roundedDownFrom?: string;
}

export interface ZeroXFeeLine {
  amount: string;
  token: string;
  type: string;
}

export interface ZeroXFees {
  /** Our own affiliate fee — server-attached, 100% plank.love's. */
  integratorFee: ZeroXFeeLine | null;
  /**
   * 0x's own on-chain cut. Per 0x's published free/starter-tier pricing,
   * this applies automatically to SELECT tokens only — it is not something
   * we choose, and we must surface it honestly rather than absorb it into
   * "our" fee line. Null/undefined when 0x is not charging on this pair.
   */
  zeroExFee: ZeroXFeeLine | null;
  gasFee?: ZeroXFeeLine | null;
  bridgeNativeFee?: ZeroXFeeLine | null;
}

/** Same-chain quote (Swap API v2) — comparable to a Uniswap CLASSIC quote. */
export interface ZeroXQuoteRequest {
  direction: SwapDirection;
  /** Base-units decimal string, EXACT_INPUT amount. */
  amount: string;
  /** Wallet that will execute the swap. Omit for an indicative price-only
   * quote — same INDICATIVE_SWAPPER substitution pattern as Uniswap. */
  swapper?: string;
  /** Percent, 0 < x <= 50. Defaults server-side to 1.0 (matches Uniswap route default). */
  slippageTolerance?: number;
  /** Optional non-PLANK side of the pair. Omitted → native ETH. */
  counterToken?: string;
}

export interface ZeroXQuoteResponse {
  provider: "0x";
  liquidityAvailable: boolean;
  buyAmount: string;
  minBuyAmount?: string;
  sellAmount: string;
  sellToken: string;
  buyToken: string;
  /** True when this response was priced against the indicative swapper. */
  indicative?: boolean;
  fees: ZeroXFees;
  transaction: {
    to: string;
    data: string;
    value: string;
    gas?: string;
    gasPrice?: string;
  } | null;
  allowanceTarget?: string | null;
  issues?: Record<string, unknown>;
  siteFee: ZeroXPublicSiteFee;
  /** Honest disclosure line for the UI — set whenever zeroExFee is non-null. */
  zeroExFeeDisclosure?: string;
}

/** Cross-chain quote (Cross-Chain API v2) — source-chain token straight into $PLANK on 4663. */
export interface ZeroXCrossChainQuoteRequest {
  /** Chain id the user is starting from (e.g. 1 = Ethereum mainnet). */
  sourceChainId: number;
  /** Token address on the source chain. Omit for native token on that chain. */
  sourceToken?: string;
  /** Base-units decimal string, amount of sourceToken to sell. */
  amount: string;
  /** Wallet that holds sourceToken and will receive $PLANK. Required —
   * cross-chain quotes are never indicative (bridge routing is address-
   * specific in a way same-chain AMM quotes are not). */
  recipient: string;
  slippageTolerance?: number;
}

export interface ZeroXCrossChainStep {
  type: string;
  chainId?: number;
  originChainId?: number;
  destinationChainId?: number;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  provider?: string;
  estimatedTimeSeconds?: number;
}

export interface ZeroXCrossChainQuoteResponse {
  provider: "0x";
  liquidityAvailable: boolean;
  originChainId: number;
  destinationChainId: number;
  sellToken: string;
  buyToken: string;
  buyAmount: string;
  minBuyAmount?: string;
  sellAmount: string;
  estimatedTimeSeconds?: number;
  steps: ZeroXCrossChainStep[];
  fees: ZeroXFees;
  transaction: {
    chainType: string;
    to: string;
    data: string;
    value: string;
    gas?: string;
  } | null;
  /** Pass this back to /api/zerox/crosschain/status alongside the origin tx
   * hash once the user sends the transaction — lets the status lookup match
   * the exact route this quote picked. Optional on 0x's side; we still
   * capture it whenever present. */
  quoteId?: string;
  siteFee: ZeroXPublicSiteFee;
  zeroExFeeDisclosure?: string;
}

/**
 * Cross-chain settlement is NON-ATOMIC — this is 0x's own documented risk,
 * not a hypothetical: the origin-chain transaction can succeed while the
 * bridge/destination leg fails, and any refund lands in whatever token the
 * FAILED STEP was trading (not necessarily the original sellToken), on
 * whichever chain that step was on — not automatically back as $PLANK, and
 * not automatically back on the source chain. `lifecycle` mirrors 0x's own
 * status states so the UI can show the user exactly where their funds are.
 */
export type ZeroXCrossChainLifecycle =
  | "origin_tx_pending"
  | "origin_tx_confirmed"
  | "bridge_pending"
  | "bridge_filled"
  | "bridge_failed"
  | "unknown";

export interface ZeroXCrossChainStatusResponse {
  lifecycle: ZeroXCrossChainLifecycle;
  /** Raw status detail from 0x, for a "view on 0x" / support-ticket link —
   * never parsed for control flow beyond the lifecycle field above. */
  raw?: Record<string, unknown>;
}

/**
 * Placeholder swapper for wallet-less price quotes. NOT the same burn
 * address lib/uniswap-types.ts uses (0x000...dEaD) — confirmed via a live
 * 0x quote (2026-07-30) that 0x's `taker` validation requires the address's
 * numeric value to exceed 0xffff (the low range some chains reserve for
 * precompiles), and 0x…dEaD (57005) falls BELOW that (65535). This address
 * is a well-known, definitely-non-precompile placeholder instead.
 */
export const ZEROX_INDICATIVE_SWAPPER = "0x1111111111111111111111111111111111111111";
