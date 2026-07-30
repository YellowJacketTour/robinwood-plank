import { PERMIT2_ADDRESS } from "@/lib/constants";
import { assertTradeOpen, TradeApiError } from "@/lib/uniswap-server";
import { INDICATIVE_SWAPPER } from "@/lib/uniswap-types";
import {
  CROSSCHAIN_DEST_CHAIN_ID,
  CROSSCHAIN_ENABLED,
  CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
  findSourceChain,
} from "@/lib/crosschain-constants";
import { assertSourceChainAllowed, crossChainFetch } from "@/lib/crosschain-server";
import {
  publicError,
  publicJson,
  rateLimit,
  readJsonBody,
  sanitizeUpstreamError,
} from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  sourceChainId?: unknown;
  amount?: unknown;
  swapper?: unknown;
  slippageTolerance?: unknown;
};

/**
 * Quote a BRIDGE-routed transfer of native currency from a source chain
 * into native ETH on Robinhood Chain — the step of the two-step flow that
 * is empirically confirmed live today (2026-07-30), unlike CHAINED routing
 * straight into $PLANK, which Uniswap's own API returns "No quotes
 * available" for (see app/api/crosschain/quote for that dormant path).
 *
 * FEE DISCLOSURE: integratorFees is deliberately NOT sent here. A live
 * side-by-side test (same amount, same pair, with vs without
 * integratorFees attached) returned byte-for-byte identical output
 * amounts — Uniswap silently ignores the fee field on BRIDGE quotes. Since
 * sending it would do nothing but could mislead a future reader into
 * thinking a fee was requested, we omit it entirely and are honest in the
 * response that this step carries no plank.love fee. The 0.4207% fee still
 * applies normally on the subsequent same-chain PLANK swap (Step 2,
 * handled by the existing widget).
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-bridge-quote", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }
    assertTradeOpen();

    const body = await readJsonBody<Body>(req);

    const sourceChainIdRaw = body.sourceChainId;
    const sourceChainId =
      typeof sourceChainIdRaw === "number" ? sourceChainIdRaw : Number(sourceChainIdRaw);
    if (!Number.isFinite(sourceChainId)) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "sourceChainId is required.");
    }
    assertSourceChainAllowed(sourceChainId);
    const sourceChain = findSourceChain(sourceChainId);
    if (!sourceChain) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "Unsupported source chain.");
    }

    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer in base units.");
    }

    const requestedSwapper = typeof body.swapper === "string" ? body.swapper.trim() : "";
    if (requestedSwapper && !/^0x[a-fA-F0-9]{40}$/.test(requestedSwapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }
    const indicative = !requestedSwapper;
    const swapper = indicative ? INDICATIVE_SWAPPER : requestedSwapper;

    const slippageTolerance =
      typeof body.slippageTolerance === "number" &&
      body.slippageTolerance > 0 &&
      body.slippageTolerance <= 50
        ? body.slippageTolerance
        : 2.5;

    const quoteBody: Record<string, unknown> = {
      tokenIn: CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
      tokenOut: CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
      tokenInChainId: sourceChain.chainId,
      tokenOutChainId: CROSSCHAIN_DEST_CHAIN_ID,
      type: "EXACT_INPUT",
      amount,
      swapper: swapper.toLowerCase(),
      slippageTolerance,
      routingPreference: "BEST_PRICE",
      // No integratorFees — see file header. Do not add this back without
      // re-verifying live that it actually changes the output amount.
    };

    const upstream = await crossChainFetch("/quote", { method: "POST", body: quoteBody });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const code = typeof data.errorCode === "string" ? data.errorCode : "";
      const msg = (typeof data.message === "string" && data.message) || detail || "";
      if (upstream.status === 429 || /rate.?limit|throttl|too many/i.test(msg + detail)) {
        return publicJson(
          { error: "RATE_LIMIT", message: "Routing is busy — wait a few seconds and try again." },
          429
        );
      }
      if (code === "ResourceNotFound" || /no quotes available/i.test(detail) || /no route/i.test(detail)) {
        return publicJson(
          {
            error: "NO_ROUTE",
            message: `No bridge route from ${sourceChain.name} to Robinhood Chain right now.`,
          },
          404
        );
      }
      const clean = sanitizeUpstreamError(data, detail || "Bridge quote request failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const routing = typeof data.routing === "string" ? data.routing : "";
    if (routing !== "BRIDGE") {
      // CHAINED/CLASSIC/anything else means Uniswap did something other
      // than the plain bridge we asked for and verified — refuse rather
      // than relay an unexpected shape.
      throw new TradeApiError(
        502,
        "BAD_ROUTING",
        `Unexpected routing "${routing}" for a bridge-only request — refusing.`
      );
    }

    const quoteObj =
      data.quote && typeof data.quote === "object" ? (data.quote as Record<string, unknown>) : data;
    const output = quoteObj.output as { amount?: string } | undefined;
    const amountOut = typeof output?.amount === "string" ? output.amount : "";
    if (!amountOut) {
      throw new TradeApiError(502, "BAD_QUOTE", "Bridge quote missing output amount.");
    }

    const permitTx = data.permitTransaction as { to?: unknown } | null | undefined;
    if (permitTx && typeof permitTx === "object" && typeof permitTx.to === "string") {
      if (permitTx.to.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) {
        throw new TradeApiError(
          502,
          "BAD_SPENDER",
          "Bridge quote approval target is not Permit2. Blocked for safety."
        );
      }
    }

    // Real, unguaranteed provider estimate only — never a marketing number.
    const estimatedFillTimeMs =
      typeof quoteObj.estimatedFillTimeMs === "number" ? quoteObj.estimatedFillTimeMs : null;

    return publicJson({
      quote: data,
      amountOut,
      routing,
      indicative,
      estimatedFillTimeMs,
      sourceChain: { chainId: sourceChain.chainId, name: sourceChain.name, nativeSymbol: sourceChain.nativeSymbol },
      destChain: { chainId: CROSSCHAIN_DEST_CHAIN_ID },
      fee: {
        appliesToThisStep: false,
        note: "No plank.love fee on this bridge step — confirmed empirically that Uniswap does not apply integrator fees to BRIDGE-routed quotes. The 0.4207% fee applies normally when you swap the bridged ETH for $PLANK in Step 2.",
      },
    });
  } catch (err) {
    return publicError(err, "Unexpected error building bridge quote.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
