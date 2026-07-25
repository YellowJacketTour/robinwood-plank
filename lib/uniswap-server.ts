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

export type SwapDirection = "buy" | "sell";

export function assertTradeOpen(): void {
  if (!isTradeOpen()) {
    throw new TradeApiError(403, "TRADE_LOCKED", "Community trade window is not open yet.");
  }
}

/**
 * Server-only Uniswap API key.
 * - Never read from the request body/headers/query
 * - Never return this value to the client
 * - Not prefixed with NEXT_PUBLIC_ (so Next will not bundle it)
 */
export function getApiKey(): string | null {
  // Explicitly only process.env — no request context.
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
 * Immutable site fee for Uniswap integratorFee.
 * Always rebuilt from SITE_FEE constants — never from client input or env.
 */
export function getIntegratorFee(): Readonly<{ bps: number; recipient: string }> {
  return Object.freeze({
    bps: SITE_FEE.bps,
    recipient: SITE_FEE.recipient,
  });
}

/** Public fee metadata only (safe to send to the browser). */
export function getPublicSiteFee() {
  return Object.freeze({
    percent: SITE_FEE.percent,
    bps: SITE_FEE.bps,
    label: SITE_FEE.label,
    recipient: SITE_FEE.recipient,
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

export function resolveTokens(direction: SwapDirection) {
  if (direction === "buy") {
    return {
      tokenIn: NATIVE_TOKEN_ADDRESS,
      tokenOut: CONTRACT_ADDRESS,
      tokenInDecimals: 18,
      tokenOutDecimals: TOKEN.decimals,
    };
  }
  return {
    tokenIn: CONTRACT_ADDRESS,
    tokenOut: NATIVE_TOKEN_ADDRESS,
    tokenInDecimals: TOKEN.decimals,
    tokenOutDecimals: 18,
  };
}

/** Only allow the official PLANK pair on Robinhood Chain. */
export function assertAllowedPair(tokenIn: string, tokenOut: string, chainId: number) {
  if (chainId !== CHAIN.id) {
    throw new TradeApiError(400, "BAD_CHAIN", `Only chain ${CHAIN.id} (Robinhood) is supported.`);
  }
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  const plank = CONTRACT_ADDRESS.toLowerCase();
  const native = NATIVE_TOKEN_ADDRESS.toLowerCase();
  const ok = (a === native && b === plank) || (a === plank && b === native);
  if (!ok) {
    throw new TradeApiError(400, "BAD_PAIR", "This widget only trades official $PLANK against ETH.");
  }
}

/**
 * Reject any attempt by the client to supply fee / routing overrides.
 * Our server is the only authority for integratorFee + pair.
 */
export function assertNoClientFeeOrRouteOverride(body: Record<string, unknown>): void {
  const forbidden = [
    "integratorFee",
    "fee",
    "fees",
    "portionBips",
    "portionRecipient",
    "portionAmount",
    "tokenIn",
    "tokenOut",
    "tokenInChainId",
    "tokenOutChainId",
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

/**
 * Before building a swap tx, ensure the quote still targets our pair + fee wallet
 * (mitigates client tampering of the quote object between /quote and /swap).
 */
export function assertQuoteIntegrity(quote: Record<string, unknown>): void {
  const input = quote.input as { token?: string } | undefined;
  const output = quote.output as { token?: string; recipient?: string } | undefined;

  const tokenIn =
    (typeof input?.token === "string" && input.token) ||
    (typeof quote.tokenIn === "string" ? quote.tokenIn : null);
  const tokenOut =
    (typeof output?.token === "string" && output.token) ||
    (typeof quote.tokenOut === "string" ? quote.tokenOut : null);

  if (tokenIn && tokenOut) {
    // Native may be zero address or chain-native encoding — normalize common forms.
    const norm = (t: string) => t.toLowerCase();
    const a = norm(tokenIn);
    const b = norm(tokenOut);
    const plank = CONTRACT_ADDRESS.toLowerCase();
    const natives = new Set([
      NATIVE_TOKEN_ADDRESS.toLowerCase(),
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    ]);
    const aIsNative = natives.has(a);
    const bIsNative = natives.has(b);
    const aIsPlank = a === plank;
    const bIsPlank = b === plank;
    const ok = (aIsNative && bIsPlank) || (aIsPlank && bIsNative);
    if (!ok) {
      throw new TradeApiError(400, "QUOTE_PAIR", "Quote is not for the official $PLANK / ETH pair.");
    }
  }

  const feeRecipient = SITE_FEE.recipient.toLowerCase();

  // Common Uniswap quote fee fields
  const portionRecipient =
    typeof quote.portionRecipient === "string" ? quote.portionRecipient.toLowerCase() : null;
  if (portionRecipient && portionRecipient !== feeRecipient) {
    throw new TradeApiError(400, "QUOTE_FEE", "Quote fee recipient does not match plank.love treasury.");
  }

  const aggregated = quote.aggregatedOutputs;
  if (Array.isArray(aggregated)) {
    for (const row of aggregated) {
      if (!row || typeof row !== "object") continue;
      const r = row as { recipient?: string; fee?: string; bps?: number };
      // Fee leg often has fee flag or small bps portion to integrator
      if (typeof r.recipient === "string" && r.recipient.toLowerCase() === feeRecipient) {
        return; // found our fee leg — good
      }
    }
  }

  // If portion fields exist with a recipient, already validated above.
  // If quote has no fee fields at all, still allow (some routes encode fee only in calldata);
  // the quote request always sets integratorFee server-side.
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

  // Deep-clone body and force-remove any fee/credential keys if present.
  const safeBody = scrubOutboundBody(body);

  const res = await fetch(`${TRADE_API}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Required for fractional integrator fee bps (0.42069% → 42.069)
      "x-universal-router-version": "2.1.1",
    },
    body: JSON.stringify(safeBody),
    cache: "no-store",
  });

  // Never log the API key. Log path + status only.
  if (!res.ok) {
    console.error(`[uniswap] ${path} → ${res.status}`);
  }

  return res;
}

function scrubOutboundBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  // Strip anything that must never be client-controlled if it sneaks in via nested quote
  delete clone.apiKey;
  delete clone.api_key;
  delete clone["x-api-key"];
  // For /quote we always re-set integratorFee after this scrub in the route.
  return clone;
}

/**
 * After a successful /quote, re-attach our fee metadata and ensure the
 * request we sent used server fee (already true). Strip nothing critical
 * from quote for swap execution, but never attach env secrets.
 */
export function attachPublicFeeMeta<T extends Record<string, unknown>>(data: T): T & {
  siteFee: ReturnType<typeof getPublicSiteFee>;
} {
  return {
    ...data,
    siteFee: getPublicSiteFee(),
  };
}
