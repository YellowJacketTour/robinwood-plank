import {
  CHAIN,
  CONTRACT_ADDRESS,
  GASLESS_SWAPS_ENABLED,
  NATIVE_TOKEN_ADDRESS,
  SITE_FEE,
  TOKEN,
  UNISWAPX_REACTOR_ADDRESS,
} from "@/lib/constants";
import { isTradeOpen } from "@/lib/trade";

const TRADE_API = "https://trade-api.gateway.uniswap.org/v1";

/** POST paths we are allowed to call on Uniswap — no open proxy. */
const ALLOWED_PATHS = new Set(["/quote", "/swap", "/check_approval", "/order"]);

/** GET paths we are allowed to call on Uniswap. */
const ALLOWED_GET_PATHS = new Set(["/orders"]);

/** Force AMM routes only so /swap works (no UniswapX /order path). */
export const AMM_PROTOCOLS = ["V2", "V3", "V4"] as const;

/**
 * AMM + UniswapX. Only used when GASLESS_SWAPS_ENABLED is on and the caller
 * opted in — UNISWAPX_V3 is the variant confirmed live on Robinhood Chain
 * (chain 4663) per Uniswap's supported-chains docs. AMM protocols stay in
 * the list too so a CLASSIC quote is always available as a fallback when no
 * UniswapX route exists (routingPreference: BEST_PRICE picks the better one).
 */
export const GASLESS_PROTOCOLS = ["V2", "V3", "V4", "UNISWAPX_V3"] as const;

/** Routing values that mean "this is a UniswapX order — use /order, not /swap". */
const DUTCH_ROUTINGS = new Set(["DUTCH_V2", "DUTCH_V3", "LIMIT_ORDER", "PRIORITY"]);

export function isDutchRouting(routing: unknown): boolean {
  return typeof routing === "string" && DUTCH_ROUTINGS.has(routing);
}

/** Server truth for whether gasless/UniswapX is switchable on at all right now. */
export function isGaslessEnabled(): boolean {
  return GASLESS_SWAPS_ENABLED;
}

/**
 * Choose the /quote `protocols` list. Gasless only applies when the flag is
 * on AND the caller explicitly opted in for this quote — CLASSIC stays the
 * default for everyone else, unchanged from pre-Phase-B behavior.
 */
export function chooseProtocols(
  wantsGasless: boolean
): typeof AMM_PROTOCOLS | typeof GASLESS_PROTOCOLS {
  return GASLESS_SWAPS_ENABLED && wantsGasless ? GASLESS_PROTOCOLS : AMM_PROTOCOLS;
}

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
  // Curated list first; anything else must pass live on-chain ERC20
  // validation (import-by-address) — either way, the token is now allowed.
  const { resolveCounterToken } = await import("@/lib/uniswap-tokenlist");
  if (!(await resolveCounterToken(counter))) {
    throw new TradeApiError(
      400,
      "BAD_PAIR",
      "That token is not on the allowed list, and does not look like a valid ERC-20 on this chain."
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
 * Pair + chain + fee checks shared by both the CLASSIC (/swap) and UniswapX
 * (/order) paths — everything EXCEPT the routing-value check, which differs
 * per caller (assertQuoteIntegrity requires CLASSIC/WRAP/UNWRAP,
 * assertOrderIntegrity requires a Dutch/UniswapX routing).
 */
async function validateQuoteCore(quote: Record<string, unknown>): Promise<void> {
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
      const { resolveCounterToken } = await import("@/lib/uniswap-tokenlist");
      if (!(await resolveCounterToken(counter))) {
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

/**
 * Before building a swap tx, ensure the quote still targets our pair + fee wallet
 * (mitigates client tampering of the quote object between /quote and /swap).
 * CLASSIC/WRAP/UNWRAP only — a Dutch/UniswapX quote here means the client is
 * calling the wrong endpoint (it belongs on /api/uniswap/order instead).
 */
export async function assertQuoteIntegrity(quote: Record<string, unknown>): Promise<void> {
  await validateQuoteCore(quote);
  const routing = typeof quote.routing === "string" ? quote.routing : null;
  if (routing && !["CLASSIC", "WRAP", "UNWRAP"].includes(routing)) {
    throw new TradeApiError(
      400,
      "BAD_ROUTING",
      `Unsupported routing "${routing}" for /swap. UniswapX quotes go through /order.`
    );
  }
}

/**
 * Order-path equivalent of assertQuoteIntegrity: validates the SAME quote
 * object (pair / chain / fee) plus the Dutch-order-specific fields the
 * client is about to sign — before we let /api/uniswap/order forward the
 * signed order to Uniswap. This is what "an order payload must be validated
 * the same way a quote is" means in practice: same core checks, plus a check
 * that the order's reactor/outputs weren't tampered with between /quote and
 * signing.
 */
export async function assertOrderIntegrity(quote: Record<string, unknown>): Promise<void> {
  await validateQuoteCore(quote);

  const routing = typeof quote.routing === "string" ? quote.routing : null;
  if (!isDutchRouting(routing)) {
    throw new TradeApiError(
      400,
      "BAD_ROUTING",
      `Routing "${routing}" is not a UniswapX order. Use /api/uniswap/swap instead.`
    );
  }

  if (!GASLESS_SWAPS_ENABLED) {
    throw new TradeApiError(403, "GASLESS_DISABLED", "Gasless swaps are not enabled.");
  }

  // orderInfo carries the actual UniswapX order fields (reactor, swapper,
  // input, outputs[]) in the JSON quote response — this is what gets ABI-
  // encoded and signed client-side. Every field here must match what we
  // expect, or a tampered quote object could get a user to sign an order
  // that settles somewhere other than the real UniswapX reactor.
  const orderInfo = (quote.orderInfo ?? quote.order) as
    | {
        reactor?: string;
        outputs?: Array<{ token?: string; recipient?: string }>;
        input?: { token?: string };
      }
    | undefined;

  if (!orderInfo || typeof orderInfo !== "object") {
    throw new TradeApiError(400, "ORDER_SHAPE", "Quote is missing UniswapX order data.");
  }

  if (
    typeof orderInfo.reactor === "string" &&
    orderInfo.reactor.toLowerCase() !== UNISWAPX_REACTOR_ADDRESS.toLowerCase()
  ) {
    throw new TradeApiError(
      400,
      "BAD_REACTOR",
      "Order reactor is not the known UniswapX reactor on Robinhood Chain. Blocked for safety."
    );
  }

  // Every output recipient must be either the swapper themselves or our fee
  // treasury — never an arbitrary third address slipped into the order.
  if (Array.isArray(orderInfo.outputs)) {
    const swapper =
      typeof quote.swapper === "string" ? quote.swapper.toLowerCase() : null;
    const feeRecipient = SITE_FEE.recipient.toLowerCase();
    for (const out of orderInfo.outputs) {
      if (!out || typeof out !== "object") continue;
      const recipient = typeof out.recipient === "string" ? out.recipient.toLowerCase() : null;
      if (recipient && recipient !== feeRecipient && recipient !== swapper) {
        throw new TradeApiError(
          400,
          "BAD_ORDER_RECIPIENT",
          "Order output recipient is not the swapper or plank.love treasury. Blocked for safety."
        );
      }
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

/**
 * GET-only counterpart to uniswapFetch, for order-status polling
 * (/orders?orderHash=...&swapper=...). Same allowlist discipline: no open
 * proxy, server-only API key, no caching of order state.
 */
export async function uniswapGetFetch(
  path: string,
  params: Record<string, string>
): Promise<Response> {
  if (!ALLOWED_GET_PATHS.has(path)) {
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

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${TRADE_API}${path}?${qs}`, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`[uniswap] GET ${path} → ${res.status}`);
  }

  return res;
}

export function attachPublicFeeMeta<T extends Record<string, unknown>>(data: T): T & {
  siteFee: ReturnType<typeof getPublicSiteFee>;
} {
  return {
    ...data,
    siteFee: getPublicSiteFee(),
  };
}
