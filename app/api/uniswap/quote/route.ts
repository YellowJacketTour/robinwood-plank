import { CHAIN } from "@/lib/constants";
import {
  assertAllowedPair,
  assertNoClientFeeOrRouteOverride,
  assertTradeOpen,
  attachPublicFeeMeta,
  getIntegratorFee,
  resolveTokens,
  TradeApiError,
  uniswapFetch,
  type SwapDirection,
} from "@/lib/uniswap-server";
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
  direction?: unknown;
  amount?: unknown;
  swapper?: unknown;
  slippageTolerance?: unknown;
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "quote", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    const direction: SwapDirection = body.direction === "sell" ? "sell" : "buy";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    const swapper = typeof body.swapper === "string" ? body.swapper.trim() : "";
    const slippageTolerance =
      typeof body.slippageTolerance === "number" &&
      body.slippageTolerance > 0 &&
      body.slippageTolerance <= 50
        ? body.slippageTolerance
        : 1.0;

    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer in base units.");
    }
    if (!swapper || !/^0x[a-fA-F0-9]{40}$/.test(swapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }

    const { tokenIn, tokenOut } = resolveTokens(direction);
    assertAllowedPair(tokenIn, tokenOut, CHAIN.id);

    // Fee is ALWAYS server-owned. Client cannot change bps or recipient.
    const integratorFee = getIntegratorFee();

    const upstream = await uniswapFetch("/quote", {
      tokenIn,
      tokenOut,
      tokenInChainId: CHAIN.id,
      tokenOutChainId: CHAIN.id,
      type: "EXACT_INPUT",
      amount,
      swapper,
      slippageTolerance,
      permitAmount: "EXACT",
      integratorFee,
    });

    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      const clean = sanitizeUpstreamError(data, "Uniswap quote request failed.");
      return publicJson(
        clean,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    return publicJson(attachPublicFeeMeta(data));
  } catch (err) {
    return publicError(err, "Unexpected error building quote.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
