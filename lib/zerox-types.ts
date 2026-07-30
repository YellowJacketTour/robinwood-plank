/**
 * Shared request/response contracts for the 0x integration
 * (app/api/zerox/* on the server, components/trade/ZeroX*.tsx on the client).
 *
 * AMOUNT DISCIPLINE: every amount crossing this boundary is a decimal string
 * in BASE UNITS (wei-scale), same convention as lib/uniswap-types.ts. Parse
 * with BigInt / lib/trade's parseTokenAmount — never Number()/parseFloat.
 */

export type SwapDirection = "buy" | "sell";

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
  siteFee: {
    percent: number;
    bps: number;
    label: string;
    recipient: string;
    enabled: boolean;
  };
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
  siteFee: {
    percent: number;
    bps: number;
    label: string;
    recipient: string;
    enabled: boolean;
  };
  zeroExFeeDisclosure?: string;
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
