/**
 * STATUS (decision recorded 2026-07-30): this Uniswap-based cross-chain
 * module is a documented, verified FALLBACK — not the shipping path. 0x's
 * Cross-Chain API (lib/zerox-server.ts, app/api/zerox/**) is what ships,
 * because the comparison was one-sided:
 *
 * - 0x: ONE signed transaction, source token -> $PLANK directly (no
 *   separate "swap the bridged ETH" step), ~4s estimated fill, and our
 *   integrator fee is actually earned.
 * - This module: two steps (bridge, then a separate same-chain swap), and
 *   — empirically confirmed, not assumed — Uniswap's BRIDGE routing
 *   silently ignores the integratorFees field entirely. Proof: the exact
 *   same 0.1 ETH mainnet -> Robinhood-Chain-native quote, requested once
 *   with integratorFees attached and once without, returned a
 *   byte-for-byte identical output.amount (99956661296552660) both times.
 *   So this path only ever earns fee in its second, hand-off step — never
 *   on the cross-chain leg itself.
 *
 * Separately, and why this module doesn't even attempt CHAINED (bridge +
 * destination swap in one Uniswap quote): as of 2026-07-30, Uniswap's
 * /quote returns "No quotes available" for any source-chain -> $PLANK
 * CHAINED request, and this is NOT $PLANK-specific — the identical request
 * for ETH -> USDG on Robinhood Chain fails the same way. Uniswap's CHAINED
 * router simply hasn't indexed this destination chain's newer pairs yet,
 * with no public ETA. The dormant CHAINED/BRIDGE quote+plan scaffolding in
 * this file (assertCrossChainDestination, assertPlanStepsSane, and
 * app/api/crosschain/{quote,plan,plan/submit}) is kept as-is against the
 * chance that changes upstream — it needs no code changes to start
 * working, just re-verification against a live quote.
 *
 * KNOWN GAP, if this module is ever revived and its flag enabled: unlike
 * the same-chain SwapWidget, which pins every swap's tx.to to the one
 * known Universal Router address, the bridge-leg transaction here targets
 * a different Across-related contract per source chain, and those
 * addresses are not individually enumerated/pinned anywhere in this
 * codebase (see the SECURITY NOTE in lib/crosschain-wallet.ts and the
 * RESIDUAL RISK comment in app/api/crosschain/bridge/swap/route.ts for the
 * specifics). Close that gap before ever flipping
 * NEXT_PUBLIC_CROSSCHAIN_ENABLED to true in production.
 */
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

/**
 * Bridge-only destination guard for the working "bridge ETH into Robinhood
 * Chain" step (see assertCrossChainDestination above for the dormant
 * CHAINED-into-$PLANK path, which is NOT live upstream as of 2026-07-30).
 * Output must be the NATIVE token, on Robinhood Chain — never $PLANK,
 * never an ERC-20, never any other chain. The user swaps for $PLANK
 * afterward through the existing same-chain widget.
 */
export function assertBridgeDestinationNative(quote: Record<string, unknown>): void {
  const output = quote.output as { token?: string; chainId?: unknown } | undefined;
  const tokenOut =
    (typeof output?.token === "string" && output.token) ||
    (typeof quote.tokenOut === "string" ? quote.tokenOut : null);
  // Live BRIDGE quotes carry the destination chain as a top-level
  // `destinationChainId` field, not `output.chainId` / `tokenOutChainId` —
  // confirmed against a real quote response (2026-07-30). Check all shapes
  // since Uniswap's field naming isn't guaranteed stable across routing types.
  const tokenOutChainId =
    output?.chainId ?? quote.tokenOutChainId ?? quote.outputChainId ?? quote.destinationChainId;

  if (!tokenOut || tokenOut.toLowerCase() !== CROSSCHAIN_NATIVE_TOKEN_ADDRESS.toLowerCase()) {
    throw new TradeApiError(
      400,
      "QUOTE_DEST",
      "Bridge quote output is not the native token — refusing."
    );
  }
  const n = typeof tokenOutChainId === "number" ? tokenOutChainId : Number(tokenOutChainId);
  if (!Number.isFinite(n) || n !== CROSSCHAIN_DEST_CHAIN_ID) {
    throw new TradeApiError(
      400,
      "QUOTE_DEST_CHAIN",
      "Bridge quote destination is not Robinhood Chain — refusing."
    );
  }
}

/** No open proxy: every path this function will call must match one of these. */
const ALLOWED_PATH_PATTERNS = [
  /^\/quote$/,
  /^\/swap$/,
  /^\/plan$/,
  /^\/plan\/[a-zA-Z0-9_-]{1,128}$/,
];

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
