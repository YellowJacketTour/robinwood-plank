import { CONTRACT_ADDRESS } from "@/lib/constants";
import { getApiKey, getIntegratorFees, TradeApiError } from "@/lib/uniswap-server";
import {
  CROSSCHAIN_DEST_CHAIN_ID,
  CROSSCHAIN_DEST_TOKEN,
  CROSSCHAIN_KNOWN_METHODS,
  CROSSCHAIN_KNOWN_STATUSES,
  CROSSCHAIN_KNOWN_STEP_TYPES,
  CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
  CROSSCHAIN_SOURCE_CHAINS,
  findSourceChain,
} from "@/lib/crosschain-constants";

// Same host as lib/uniswap-server.ts's TRADE_API — duplicated locally rather
// than exported from that file, which is out of scope for this feature.
const TRADE_API = "https://trade-api.gateway.uniswap.org/v1";

export function isCrossChainApiConfigured(): boolean {
  return Boolean(getApiKey());
}

/** Every source chain this feature is willing to quote from. Client-supplied
 * chainId is validated against this allowlist before anything reaches
 * Uniswap — never trust a client-picked arbitrary chain id. */
export function assertSourceChainAllowed(chainId: number): void {
  if (!findSourceChain(chainId)) {
    throw new TradeApiError(
      400,
      "BAD_SOURCE_CHAIN",
      "That source chain is not supported yet for cross-chain buys."
    );
  }
  if (chainId === CROSSCHAIN_DEST_CHAIN_ID) {
    throw new TradeApiError(
      400,
      "SAME_CHAIN",
      "Source and destination are the same chain — use the regular Trade widget instead."
    );
  }
}

/**
 * Destination is hard-locked: official $PLANK on Robinhood Chain, always.
 * Mirrors assertQuoteIntegrity's chain guard in lib/uniswap-server.ts, but
 * this endpoint's whole purpose is a cross-chain (tokenInChainId !=
 * tokenOutChainId) quote, so we assert the OUTPUT side instead of rejecting
 * any chain mismatch outright.
 */
export function assertCrossChainDestination(quote: Record<string, unknown>): void {
  const output = quote.output as { token?: string; chainId?: unknown } | undefined;
  const tokenOut =
    (typeof output?.token === "string" && output.token) ||
    (typeof quote.tokenOut === "string" ? quote.tokenOut : null);
  const tokenOutChainId =
    output?.chainId ?? quote.tokenOutChainId ?? quote.outputChainId;

  if (!tokenOut || tokenOut.toLowerCase() !== CROSSCHAIN_DEST_TOKEN.toLowerCase()) {
    throw new TradeApiError(
      400,
      "QUOTE_DEST",
      "Quote output is not official $PLANK — refusing."
    );
  }
  const n = typeof tokenOutChainId === "number" ? tokenOutChainId : Number(tokenOutChainId);
  if (!Number.isFinite(n) || n !== CROSSCHAIN_DEST_CHAIN_ID) {
    throw new TradeApiError(
      400,
      "QUOTE_DEST_CHAIN",
      "Quote destination is not Robinhood Chain — refusing."
    );
  }
}

/** Reject client-supplied fee/route/destination overrides — same spirit as
 * assertNoClientFeeOrRouteOverride in lib/uniswap-server.ts. */
export function assertNoCrossChainOverride(body: Record<string, unknown>): void {
  const forbidden = [
    "integratorFee",
    "integratorFees",
    "fee",
    "fees",
    "portionBips",
    "portionRecipient",
    "portionAmount",
    "tokenOut",
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
        `Client may not set "${key}". Destination, pair, and fee are server-controlled.`
      );
    }
  }
}

export type PlanStep = {
  stepIndex?: number;
  stepType?: string;
  method?: string;
  payloadType?: string;
  status?: string;
  chainId?: number;
  payload?: Record<string, unknown>;
};

/**
 * Fail-closed validation of a /plan response's steps: reject anything whose
 * shape we don't recognize or whose chainId isn't the declared source chain
 * or Robinhood Chain. This is the cross-chain analogue of SwapWidget's
 * "never a bridge to an unknown contract" guard — we cannot pin an exact
 * Across SpokePool address per chain the way the same-chain widget pins
 * Universal Router, so the guard here is: known step shapes only, and only
 * the two chains this specific plan is allowed to touch.
 */
export function assertPlanStepsSane(
  steps: unknown,
  sourceChainId: number
): asserts steps is PlanStep[] {
  if (!Array.isArray(steps)) {
    throw new TradeApiError(502, "BAD_PLAN", "Plan response missing steps.");
  }
  for (const raw of steps) {
    if (!raw || typeof raw !== "object") {
      throw new TradeApiError(502, "BAD_PLAN_STEP", "Plan step is not an object.");
    }
    const step = raw as PlanStep;
    if (step.stepType && !CROSSCHAIN_KNOWN_STEP_TYPES.has(step.stepType)) {
      throw new TradeApiError(
        502,
        "BAD_PLAN_STEP",
        `Unrecognized plan step type "${step.stepType}" — refusing to relay.`
      );
    }
    if (step.method && !CROSSCHAIN_KNOWN_METHODS.has(step.method)) {
      throw new TradeApiError(
        502,
        "BAD_PLAN_STEP",
        `Unrecognized plan step method "${step.method}" — refusing to relay.`
      );
    }
    if (step.status && !CROSSCHAIN_KNOWN_STATUSES.has(step.status)) {
      throw new TradeApiError(
        502,
        "BAD_PLAN_STEP",
        `Unrecognized plan step status "${step.status}" — refusing to relay.`
      );
    }
    if (
      step.chainId !== undefined &&
      step.chainId !== sourceChainId &&
      step.chainId !== CROSSCHAIN_DEST_CHAIN_ID
    ) {
      throw new TradeApiError(
        502,
        "BAD_PLAN_CHAIN",
        `Plan step targets chain ${step.chainId}, which is neither the source chain nor Robinhood Chain — refusing to relay.`
      );
    }
  }
}

/** No open proxy: every path this function will call must match one of these. */
const ALLOWED_PATH_PATTERNS = [/^\/quote$/, /^\/plan$/, /^\/plan\/[a-zA-Z0-9_-]{1,128}$/];

export async function crossChainFetch(
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown; query?: Record<string, string> }
): Promise<Response> {
  if (!ALLOWED_PATH_PATTERNS.some((re) => re.test(path))) {
    throw new TradeApiError(500, "BAD_PATH", "Internal routing error.");
  }
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new TradeApiError(
      503,
      "NO_API_KEY",
      "Cross-chain routing is not configured on the server."
    );
  }

  let url = `${TRADE_API}${path}`;
  if (init.query) {
    const qs = new URLSearchParams(init.query).toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method: init.method,
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-universal-router-version": "2.1.1",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`[crosschain] ${init.method} ${path} → ${res.status}`);
  }
  return res;
}

/** Public list of source chains — safe to send to the browser. */
export function getPublicSourceChains() {
  return CROSSCHAIN_SOURCE_CHAINS.map((c) => ({
    chainId: c.chainId,
    name: c.name,
    nativeSymbol: c.nativeSymbol,
  }));
}

export {
  CROSSCHAIN_DEST_CHAIN_ID,
  CROSSCHAIN_DEST_TOKEN,
  CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
  CONTRACT_ADDRESS as PLANK_ADDRESS,
  getIntegratorFees,
};
