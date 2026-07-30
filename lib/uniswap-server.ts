import {
  CHAIN,
  CONTRACT_ADDRESS,
  NATIVE_TOKEN_ADDRESS,
  SITE_FEE,
  TOKEN,
} from "@/lib/constants";
import { isTradeOpen } from "@/lib/trade";

const TRADE_API = "https://trade-api.gateway.uniswap.org/v1";

/** Paths we are allowed to call on Uniswap — no open proxy. */
const ALLOWED_PATHS = new Set(["/quote", "/swap", "/check_approval"]);

/** Force AMM routes only so /swap works (no UniswapX /order path). */
export const AMM_PROTOCOLS = ["V2", "V3", "V4"] as const;

export type SwapDirection = "buy" | "sell";

export function assertTradeOpen(): void {
  if (!isTradeOpen()) {
    throw new TradeApiError(
      403,
      "TRADE_LOCKED",
      "Official trade is not open yet (or temporarily paused). Use the Uniswap buttons when trading is live, or wait for unlock."
    );
  }
}

/**
 * Server-only Uniswap API key.
 * - Never read from the request body/headers/query
 * - Never return this value to the client
 * - Not prefixed with NEXT_PUBLIC_ (so Next will not bundle it)
 */
export function getApiKey(): string | null {
  const key = process.env.UNISWAP_API_KEY;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length < 16) return null;
  return trimmed;
}

export function isTradingApiConfigured(): boolean {
  return Boolean(getApiKey());
}

/**
 * Immutable site fee for Uniswap Trading API.
 * Spec: QuoteRequest.integratorFees: IntegratorFee[] with fields { bips, recipient }.
 * (Not "bps" / not singular "integratorFee" — those are invalid per OpenAPI.)
 */
export function getIntegratorFees(): ReadonlyArray<
  Readonly<{ bips: number; recipient: string }>
> {
  // bps=0 / enabled=false → no fee commands on UR (full PLANK to buyer)
  if (!SITE_FEE.enabled || !SITE_FEE.bps || SITE_FEE.bps <= 0) {
    return Object.freeze([]);
  }
  return Object.freeze([
    Object.freeze({
      bips: SITE_FEE.bps,
      recipient: SITE_FEE.recipient.toLowerCase(),
    }),
  ]);
}

/** @deprecated use getIntegratorFees — kept name clarity for call sites */
export function getIntegratorFee() {
  return getIntegratorFees()[0];
}

/** Public fee metadata only (safe to send to the browser). */
export function getPublicSiteFee() {
  return Object.freeze({
    percent: SITE_FEE.percent,
    bps: SITE_FEE.bps,
    bips: SITE_FEE.bps,
    label: SITE_FEE.label,
    recipient: SITE_FEE.recipient,
    enabled: Boolean(SITE_FEE.enabled && SITE_FEE.bps > 0),
  });
}

export class TradeApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TradeApiError";
    this.status = status;
    this.code = code;
  }
}

export function resolveTokens(
  direction: SwapDirection,
  counter?: { address: string; decimals: number }
) {
  const c = counter ?? { address: NATIVE_TOKEN_ADDRESS, decimals: 18 };
  if (direction === "buy") {
    return {
      tokenIn: c.address,
      tokenOut: CONTRACT_ADDRESS,
      tokenInDecimals: c.decimals,
      tokenOutDecimals: TOKEN.decimals,
    };
  }
  return {
    tokenIn: CONTRACT_ADDRESS,
    tokenOut: c.address,
    tokenInDecimals: TOKEN.decimals,
    tokenOutDecimals: c.decimals,
  };
}

/**
 * Every pair must have official $PLANK on exactly one side; the other side
 * must be an allowed counter token (native ETH or a token from the
 * server-side allowlist — lib/uniswap-tokenlist.ts). The router handles
 * any multihop between them.
 */
export async function assertAllowedPair(tokenIn: string, tokenOut: string, chainId: number) {
  if (chainId !== CHAIN.id) {
    throw new TradeApiError(400, "BAD_CHAIN", `Only chain ${CHAIN.id} (Robinhood) is supported.`);
  }
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  const plank = CONTRACT_ADDRESS.toLowerCase();
  const counter = a === plank ? b : b === plank ? a : null;
  if (!counter || a === b) {
    throw new TradeApiError(400, "BAD_PAIR", "This widget only trades official $PLANK pairs.");
  }
  const { getCounterToken } = await import("@/lib/uniswap-tokenlist");
  if (!(await getCounterToken(counter))) {
    throw new TradeApiError(
      400,
      "BAD_PAIR",
      "That token is not on the allowed list for $PLANK trading."
    );
  }
}

/**
 * Reject any attempt by the client to supply fee / routing overrides.
 * Our server is the only authority for integratorFees + pair.
 */
export function assertNoClientFeeOrRouteOverride(body: Record<string, unknown>): void {
  const forbidden = [
    "integratorFee",
    "integratorFees",
    "fee",
    "fees",
    "portionBips",
    "portionRecipient",
    "portionAmount",
    "tokenIn",
    "tokenOut",
    "tokenInChainId",
    "tokenOutChainId",
    "protocols",
    "routingPreference",
    "apiKey",
    "api_key",
    "x-api-key",
    "UNISWAP_API_KEY",
  ] as const;

  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined) {
      throw new TradeApiError(
        400,
        "FORBIDDEN_FIELD",
        `Client may not set "${key}". Pair, fee, and API credentials are server-controlled.`
      );
    }
  }
}

const NATIVE_ALIASES = new Set([
  NATIVE_TOKEN_ADDRESS.toLowerCase(),
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
]);

function isNative(addr: string) {
  return NATIVE_ALIASES.has(addr.toLowerCase());
}

function isPlank(addr: string) {
  return addr.toLowerCase() === CONTRACT_ADDRESS.toLowerCase();
}

/**
 * Before building a swap tx, ensure the quote still targets our pair + fee wallet
 * (mitigates client tampering of the quote object between /quote and /swap).
 */
export async function assertQuoteIntegrity(quote: Record<string, unknown>): Promise<void> {
  const input = quote.input as { token?: string } | undefined;
  const output = quote.output as { token?: string; recipient?: string } | undefined;

  const tokenIn =
    (typeof input?.token === "string" && input.token) ||
    (typeof quote.tokenIn === "string" ? quote.tokenIn : null);
  const tokenOut =
    (typeof output?.token === "string" && output.token) ||
    (typeof quote.tokenOut === "string" ? quote.tokenOut : null);

  if (!tokenIn || !tokenOut) {
    throw new TradeApiError(400, "QUOTE_PAIR", "Quote missing token pair metadata.");
  }
  {
    // Same rule as assertAllowedPair: PLANK on exactly one side, the other
    // side native or on the server allowlist. WETH counts as native here —
    // the router legitimately wraps for CLASSIC routes.
    const counter = isPlank(tokenIn) ? tokenOut : isPlank(tokenOut) ? tokenIn : null;
    if (!counter) {
      throw new TradeApiError(400, "QUOTE_PAIR", "Quote is not for an official $PLANK pair.");
    }
    if (!isNative(counter)) {
      const { getCounterToken } = await import("@/lib/uniswap-tokenlist");
      if (!(await getCounterToken(counter))) {
        throw new TradeApiError(400, "QUOTE_PAIR", "Quote counter token is not on the allowed list.");
      }
    }
  }

  // Belt-and-suspenders: if the quote carries explicit chain fields (input-
  // side, output-side, or top-level), every one of them must be Robinhood
  // Chain. A cross-chain quote is exactly the shape that resolves into a
  // bridge deposit instead of a same-chain swap.
  {
    const chainFields = [
      (input as { chainId?: unknown } | undefined)?.chainId,
      (output as { chainId?: unknown } | undefined)?.chainId,
      quote.tokenInChainId,
      quote.tokenOutChainId,
      quote.chainId,
    ].filter((v) => v !== undefined && v !== null);
    for (const v of chainFields) {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n) || n !== CHAIN.id) {
        throw new TradeApiError(
          400,
          "QUOTE_CHAIN",
          "Quote references a different chain than Robinhood — refusing (would not be a same-chain swap)."
        );
      }
    }
  }

  // Classic swaps only — UniswapX needs /order, not /swap
  const routing = typeof quote.routing === "string" ? quote.routing : null;
  // routing may live on the outer response; also reject Dutch-style encodedOrder-only quotes without classic fields
  if (routing && !["CLASSIC", "WRAP", "UNWRAP"].includes(routing)) {
    throw new TradeApiError(
      400,
      "BAD_ROUTING",
      `Unsupported routing "${routing}". Official widget uses Uniswap AMM only.`
    );
  }

  const feeRecipient = SITE_FEE.recipient.toLowerCase();

  const portionRecipient =
    typeof quote.portionRecipient === "string" ? quote.portionRecipient.toLowerCase() : null;
  if (portionRecipient && portionRecipient !== feeRecipient) {
    throw new TradeApiError(400, "QUOTE_FEE", "Quote fee recipient does not match plank.love treasury.");
  }

  // When the quote exposes fee routing fields, they must match our treasury.
  // If Uniswap omits them (shape variance), pair + server-side integratorFees on /quote still bind fees.
  const aggregated = quote.aggregatedOutputs;
  if (Array.isArray(aggregated) && aggregated.length > 0) {
    let sawFeeWallet = false;
    for (const row of aggregated) {
      if (!row || typeof row !== "object") continue;
      const r = row as { recipient?: string };
      if (typeof r.recipient === "string" && r.recipient.toLowerCase() === feeRecipient) {
        sawFeeWallet = true;
        break;
      }
    }
    // Only hard-fail when portionBips / fee fields imply a cut but wrong wallet
    const hasPortion =
      quote.portionBips != null ||
      quote.portionAmount != null ||
      portionRecipient != null;
    if (hasPortion && !sawFeeWallet && portionRecipient && portionRecipient !== feeRecipient) {
      throw new TradeApiError(
        400,
        "QUOTE_FEE",
        "Quote fee routing does not match plank.love treasury."
      );
    }
  }
}

/** Pull amountOut from ClassicQuote / Dutch-style quote shapes. */
export function extractAmountOut(quote: Record<string, unknown>): string {
  const output = quote.output as { amount?: string } | undefined;
  if (output && typeof output.amount === "string" && output.amount) return output.amount;
  if (typeof quote.amountOut === "string" && quote.amountOut) return quote.amountOut;
  if (typeof quote.expectedAmountOut === "string" && quote.expectedAmountOut) {
    return quote.expectedAmountOut;
  }
  return "";
}

export async function uniswapFetch(path: string, body: unknown): Promise<Response> {
  if (!ALLOWED_PATHS.has(path)) {
    throw new TradeApiError(500, "BAD_PATH", "Internal routing error.");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new TradeApiError(
      503,
      "NO_API_KEY",
      "Uniswap Trading API key is not configured on the server."
    );
  }

  const safeBody = scrubOutboundBody(body);

  const res = await fetch(`${TRADE_API}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Required for fractional integrator fee bips (0.4207% → 42.07)
      "x-universal-router-version": "2.1.1",
    },
    body: JSON.stringify(safeBody),
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`[uniswap] ${path} → ${res.status}`);
  }

  return res;
}

function scrubOutboundBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  return JSON.parse(JSON.stringify(body));
}

export function attachPublicFeeMeta<T extends Record<string, unknown>>(data: T): T & {
  siteFee: ReturnType<typeof getPublicSiteFee>;
} {
  return {
    ...data,
    siteFee: getPublicSiteFee(),
  };
}
