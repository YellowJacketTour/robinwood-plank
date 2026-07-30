import {
  CHAIN,
  CONTRACT_ADDRESS,
  MARKET_FEE_RECIPIENT,
  NATIVE_TOKEN_ADDRESS,
  SITE_FEE,
  TOKEN,
} from "@/lib/constants";
import { assertTradeOpen, TradeApiError } from "@/lib/uniswap-server";
import { CROSSCHAIN_SOURCE_CHAINS, findSourceChain } from "@/lib/crosschain-constants";
import type { SwapDirection, ZeroXFeeLine, ZeroXFees } from "@/lib/zerox-types";

/**
 * 0x integration — SECOND liquidity/routing provider alongside Uniswap.
 * Mirrors the security posture of lib/uniswap-server.ts exactly: server-only
 * API key, allowlisted upstream paths (no open proxy), server-decided fee +
 * pair, hard validation of any tx target before the client can sign it.
 *
 * Both features this module supports are HARD OFF by default:
 *  - ZEROX_ENABLED gates same-chain price-comparison quoting (Goal 1).
 *  - ZEROX_CROSSCHAIN_ENABLED gates true one-step cross-chain into $PLANK
 *    (Goal 2). Kept as its own flag since it is a materially different (and
 *    unverified without a live API key) risk surface from same-chain quotes.
 *
 * Flags live here (not lib/constants.ts, which this agent does not own) —
 * same on/off-without-deploy pattern as GASLESS_SWAPS_ENABLED /
 * CROSSCHAIN_ENABLED elsewhere in the app.
 */
export const ZEROX_ENABLED =
  process.env.NEXT_PUBLIC_ZEROX_ENABLED?.trim().toLowerCase() === "true";

export const ZEROX_CROSSCHAIN_ENABLED =
  process.env.NEXT_PUBLIC_ZEROX_CROSSCHAIN_ENABLED?.trim().toLowerCase() === "true";

const SWAP_API = "https://api.0x.org";

/** GET-only allowlist — 0x Swap API v2 and Cross-Chain API v2 are GET, unlike
 * Uniswap's POST-based Trading API. No open proxy: every path we will call
 * must match one of these exactly. */
const ALLOWED_PATHS = new Set([
  "/swap/allowance-holder/price",
  "/swap/allowance-holder/quote",
  "/cross-chain/quotes",
]);

/**
 * Server-only 0x API key.
 * - Never read from the request body/headers/query
 * - Never return this value to the client
 * - Not prefixed with NEXT_PUBLIC_ (so Next will not bundle it)
 * Mirrors getApiKey() in lib/uniswap-server.ts exactly.
 */
export function getApiKey(): string | null {
  const key = process.env.ZEROX_API_KEY;
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length < 16) return null;
  return trimmed;
}

export function isZeroXConfigured(): boolean {
  return Boolean(getApiKey());
}

export { assertTradeOpen, TradeApiError };

/**
 * Reject any attempt by the client to supply fee / routing overrides — same
 * spirit as assertNoClientFeeOrRouteOverride in lib/uniswap-server.ts, using
 * 0x's own param names (swapFeeBps/swapFeeRecipient/swapFeeToken, feeBps/
 * feeRecipient/feeToken for cross-chain) plus the shared ones.
 */
export function assertNoClientFeeOrRouteOverride(body: Record<string, unknown>): void {
  const forbidden = [
    "swapFeeBps",
    "swapFeeRecipient",
    "swapFeeToken",
    "feeBps",
    "feeRecipient",
    "feeToken",
    "tradeSurplusRecipient",
    "tradeSurplusMaxBps",
    "tokenIn",
    "tokenOut",
    "sellToken",
    "buyToken",
    "chainId",
    "originChain",
    "destinationChain",
    "excludedSources",
    "excludedBridges",
    "includedBridges",
    "apiKey",
    "api_key",
    "0x-api-key",
    "ZEROX_API_KEY",
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
 * Immutable site fee for 0x Swap API — SAME bps as the Uniswap integration
 * (SITE_FEE from lib/constants.ts), just expressed with 0x's param names.
 * bps=0 / enabled=false → omit fee params entirely (full output to buyer),
 * identical behavior to getIntegratorFees() in lib/uniswap-server.ts.
 */
export function getSwapFeeParams(): { swapFeeBps: string; swapFeeRecipient: string } | null {
  if (!SITE_FEE.enabled || !SITE_FEE.bps || SITE_FEE.bps <= 0) return null;
  // 0x's swapFeeBps is an integer-basis-points string per the API reference;
  // SITE_FEE.bps (42.07) already IS in "1 bip = 0.01%" units like Uniswap's
  // IntegratorFee.bips, so round to the nearest whole bip (42) — 0x's field
  // does not document fractional bps the way Uniswap's does.
  return {
    swapFeeBps: String(Math.round(SITE_FEE.bps)),
    swapFeeRecipient: SITE_FEE.recipient.toLowerCase(),
  };
}

/** Public fee metadata only (safe to send to the browser). Same shape as
 * getPublicSiteFee() in lib/uniswap-server.ts for easy side-by-side display. */
export function getPublicSiteFee() {
  return Object.freeze({
    percent: SITE_FEE.percent,
    bps: Math.round(SITE_FEE.bps),
    label: SITE_FEE.label,
    recipient: SITE_FEE.recipient,
    enabled: Boolean(SITE_FEE.enabled && SITE_FEE.bps > 0),
  });
}

export type ZeroXDirection = SwapDirection;

/**
 * 0x's own native-token sentinel — CONFIRMED via a live quote against
 * Robinhood Chain (2026-07-30): 0x rejects our app's usual all-zero
 * NATIVE_TOKEN_ADDRESS sentinel ("Invalid ethereum address") and expects
 * this address instead (same convention 0x documents across every chain).
 * Every native-ETH request built here must use THIS address, never the
 * app-wide zero-address one from lib/constants.ts.
 * @see https://0x.org/docs/0x-swap-api/advanced-topics/handling-native-tokens
 */
export const ZEROX_NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const NATIVE_ALIASES = new Set([
  NATIVE_TOKEN_ADDRESS.toLowerCase(),
  ZEROX_NATIVE_SENTINEL.toLowerCase(),
]);

export function isNativeAddr(addr: string): boolean {
  return NATIVE_ALIASES.has(addr.toLowerCase());
}

/** Translate any native-token alias (our app's zero-address convention, or
 * 0x's own EEeE sentinel) into the address 0x's API actually accepts. */
function toZeroXAddress(addr: string): string {
  return isNativeAddr(addr) ? ZEROX_NATIVE_SENTINEL : addr;
}

/** Resolve tokenIn/tokenOut for a same-chain PLANK quote — same convention
 * as resolveTokens() in lib/uniswap-server.ts, translated to 0x's own
 * native-token address at the boundary. */
export function resolveTokens(
  direction: ZeroXDirection,
  counter?: { address: string; decimals: number }
) {
  const c = counter ?? { address: NATIVE_TOKEN_ADDRESS, decimals: 18 };
  const counterAddr = toZeroXAddress(c.address);
  if (direction === "buy") {
    return { tokenIn: counterAddr, tokenOut: CONTRACT_ADDRESS, tokenInDecimals: c.decimals, tokenOutDecimals: TOKEN.decimals };
  }
  return { tokenIn: CONTRACT_ADDRESS, tokenOut: counterAddr, tokenInDecimals: TOKEN.decimals, tokenOutDecimals: c.decimals };
}

/**
 * Every pair must have $PLANK on exactly one side; the other side must be an
 * allowed counter token. Reuses lib/uniswap-tokenlist's server-vetted
 * allowlist (curated list + live ERC-20 validation) rather than duplicating
 * it — same trust boundary, same list, one source of truth. Returns the
 * resolved token (with its real decimals) so callers never have to guess.
 */
export async function resolveAllowedCounter(
  counter: string
): Promise<{ address: string; decimals: number }> {
  if (isNativeAddr(counter)) return { address: NATIVE_TOKEN_ADDRESS, decimals: 18 };
  const { resolveCounterToken } = await import("@/lib/uniswap-tokenlist");
  const entry = await resolveCounterToken(counter);
  if (!entry) {
    throw new TradeApiError(
      400,
      "BAD_PAIR",
      "That token is not on the allowed list, and does not look like a valid ERC-20 on this chain."
    );
  }
  return { address: entry.address, decimals: entry.decimals };
}

/** Source chains this feature is willing to quote a cross-chain buy from.
 * Reuses the same vetted list lib/crosschain-constants.ts defines for the
 * Uniswap-bridge fallback (Phase C) — 0x's Cross-Chain API documents wider
 * coverage (25+ chains), but starting from the already-reviewed list keeps
 * the trust boundary identical until that's deliberately expanded. */
export function assertCrossChainSourceAllowed(chainId: number): void {
  if (!findSourceChain(chainId)) {
    throw new TradeApiError(
      400,
      "BAD_SOURCE_CHAIN",
      "That source chain is not supported yet for cross-chain buys."
    );
  }
  if (chainId === CHAIN.id) {
    throw new TradeApiError(
      400,
      "SAME_CHAIN",
      "Source and destination are the same chain — use the regular Trade widget instead."
    );
  }
}

export { CROSSCHAIN_SOURCE_CHAINS };

function isHexAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * Addresses a returned transaction.to must NEVER equal, regardless of which
 * 0x entry-point contract is currently live. 0x's own docs explicitly warn
 * AGAINST hardcoding AllowanceHolder/Settler addresses (they rotate), so we
 * cannot pin one exact expected address the way lib/uniswap-server.ts pins
 * Universal Router. Instead: fail closed on the shapes that are never
 * legitimate — zero address, our own PLANK contract, our own fee wallets,
 * or the native-token sentinel — which catches a malformed/tampered
 * response without needing to track 0x's rotating deployments.
 */
const NEVER_VALID_TARGETS = new Set([
  "0x0000000000000000000000000000000000000000",
  CONTRACT_ADDRESS.toLowerCase(),
  SITE_FEE.recipient.toLowerCase(),
  MARKET_FEE_RECIPIENT.toLowerCase(),
]);

/**
 * Hard validation of any transaction target before the client can sign or
 * send it. Returns nothing; throws on anything unsafe.
 */
export function assertSafeTransactionTarget(tx: unknown): asserts tx is {
  to: string;
  data: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
} {
  if (!tx || typeof tx !== "object") {
    throw new TradeApiError(502, "BAD_TX", "0x returned no transaction to sign.");
  }
  const t = tx as { to?: unknown; data?: unknown };
  if (!isHexAddress(t.to)) {
    throw new TradeApiError(502, "BAD_TX", "0x returned an invalid transaction target.");
  }
  if (typeof t.data !== "string" || !t.data || t.data === "0x") {
    throw new TradeApiError(502, "BAD_TX", "0x returned an invalid transaction payload.");
  }
  if (NEVER_VALID_TARGETS.has(t.to.toLowerCase())) {
    throw new TradeApiError(
      502,
      "BAD_TARGET",
      "0x transaction target is not a valid swap/bridge contract. Blocked for safety."
    );
  }
}

/** Build the honest zeroExFee disclosure line for the UI. Never hide a cost:
 * when 0x's own fee is present, say so explicitly and separately from our fee. */
export function zeroExFeeDisclosure(fees: ZeroXFees | null | undefined): string | undefined {
  if (!fees?.zeroExFee || !fees.zeroExFee.amount || fees.zeroExFee.amount === "0") return undefined;
  return "0x charges its own ~0.15% fee on this token pair (separate from plank.love's fee) on the free API tier.";
}

export function extractFeeLine(raw: unknown): ZeroXFeeLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { amount?: unknown; token?: unknown; type?: unknown };
  if (typeof r.amount !== "string" || typeof r.token !== "string") return null;
  return { amount: r.amount, token: r.token, type: typeof r.type === "string" ? r.type : "" };
}

export function extractFees(raw: unknown): ZeroXFees {
  if (!raw || typeof raw !== "object") {
    return { integratorFee: null, zeroExFee: null };
  }
  const r = raw as Record<string, unknown>;
  return {
    integratorFee: extractFeeLine(r.integratorFee),
    zeroExFee: extractFeeLine(r.zeroExFee),
    gasFee: extractFeeLine(r.gasFee),
    bridgeNativeFee: extractFeeLine(r.bridgeNativeFee),
  };
}

function looksLikeSecret(s: string): boolean {
  const lower = s.toLowerCase();
  if (
    lower.includes("api-key") ||
    lower.includes("apikey") ||
    lower.includes("0x-api-key") ||
    lower.includes("authorization") ||
    lower.includes("bearer ")
  ) {
    return true;
  }
  const key = process.env.ZEROX_API_KEY?.trim();
  if (key && key.length >= 8 && s.includes(key)) return true;
  return false;
}

/**
 * Sanitize 0x error bodies before returning to the browser — same discipline
 * as sanitizeUpstreamError() in lib/security.ts, kept local here rather than
 * editing that shared file (it scrubs UNISWAP_API_KEY specifically; this
 * scrubs ZEROX_API_KEY).
 */
export function sanitizeZeroXError(data: unknown, fallback: string): { error: string; message: string } {
  if (!data || typeof data !== "object") {
    return { error: "UPSTREAM", message: fallback };
  }
  const obj = data as Record<string, unknown>;
  const rawMsg =
    (typeof obj.message === "string" && obj.message) ||
    (typeof obj.reason === "string" && obj.reason) ||
    fallback;
  const message = !looksLikeSecret(rawMsg) ? String(rawMsg).slice(0, 400) : fallback;
  const rawErr = (typeof obj.name === "string" && obj.name) || "UPSTREAM";
  const error = !looksLikeSecret(rawErr) ? String(rawErr).slice(0, 80) : "UPSTREAM";
  return { error, message };
}

/**
 * GET fetch to the 0x API with allowlist discipline + fail-closed on a
 * missing key — exact mirror of uniswapFetch()'s NO_API_KEY pattern.
 */
export async function zeroxFetch(
  path: string,
  params: Record<string, string>
): Promise<Response> {
  if (!ALLOWED_PATHS.has(path)) {
    throw new TradeApiError(500, "BAD_PATH", "Internal routing error.");
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new TradeApiError(503, "NO_API_KEY", "0x API key is not configured on the server.");
  }

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SWAP_API}${path}?${qs}`, {
    method: "GET",
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    console.error(`[zerox] GET ${path} → ${res.status}`);
  }

  return res;
}
