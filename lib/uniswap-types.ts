/**
 * Shared request/response contracts for the Uniswap trade API
 * (app/api/uniswap/* on the server, components/trade/SwapWidget.tsx on the
 * client).
 *
 * AMOUNT DISCIPLINE: every amount crossing this boundary is a decimal
 * string in BASE UNITS (wei-scale). Parse with BigInt / lib/trade's
 * parseTokenAmount and format with formatTokenAmount — never Number() or
 * parseFloat, which silently lose precision on $PLANK-sized quantities.
 */

export type SwapDirection = "buy" | "sell";

export interface UniswapQuoteRequest {
  direction: SwapDirection;
  /** Base-units decimal string (BigInt-safe), EXACT_INPUT amount. */
  amount: string;
  /**
   * Wallet that will execute the swap. OPTIONAL: omit for an indicative
   * price-only quote (no wallet connected) — the server substitutes
   * INDICATIVE_SWAPPER and flags the response; execution always requires a
   * fresh quote with the real wallet.
   */
  swapper?: string;
  /** Percent, 0 < x <= 50. Defaults server-side to 1.0. */
  slippageTolerance?: number;
}

export interface PermitData {
  domain: unknown;
  types: Record<string, unknown>;
  values: unknown;
}

/** The upstream quote object we actually read fields from. */
export interface QuoteInner {
  output?: { amount?: string };
  /** Base-units decimal strings. */
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasUseEstimate?: string | number;
  [key: string]: unknown;
}

export interface UniswapQuoteResponse {
  routing: string;
  quote: QuoteInner;
  /** Base-units decimal string — format with formatTokenAmount(BigInt). */
  amountOut: string;
  /**
   * True when the quote was priced against INDICATIVE_SWAPPER because no
   * wallet was supplied. Display-only: never executable — the client must
   * re-quote with the connected wallet before swapping.
   */
  indicative?: boolean;
  isTokenApprovalApplicable?: boolean;
  permitData?: PermitData | null;
  permitTransaction?: Record<string, string> | null;
  boards?: {
    widgetVerified: boolean;
    side?: string;
    cooldown?: unknown;
    session?: unknown;
  };
  [key: string]: unknown;
}

/**
 * Placeholder swapper for wallet-less price quotes. The canonical burn
 * address: always a valid, never-contract account, so upstream routing and
 * gas simulation behave like any EOA.
 */
export const INDICATIVE_SWAPPER = "0x000000000000000000000000000000000000dEaD";
