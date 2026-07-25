import {
  assertNoClientFeeOrRouteOverride,
  assertQuoteIntegrity,
  assertTradeOpen,
  TradeApiError,
  uniswapFetch,
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
  quote?: unknown;
  signature?: unknown;
  permitData?: unknown;
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "swap", limit: 20, windowMs: 60_000 });
    if (limited) return limited;

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    if (!body.quote || typeof body.quote !== "object" || Array.isArray(body.quote)) {
      throw new TradeApiError(400, "BAD_QUOTE", "quote object is required.");
    }

    const quote = body.quote as Record<string, unknown>;
    assertQuoteIntegrity(quote);

    // CreateSwapRequest: quote + optional permit signature pair
    const payload: Record<string, unknown> = {
      quote,
      refreshGasPrice: true,
      simulateTransaction: true,
    };
    if (
      body.permitData &&
      typeof body.permitData === "object" &&
      typeof body.signature === "string" &&
      body.signature.length > 0
    ) {
      payload.permitData = body.permitData;
      payload.signature = body.signature;
    }

    const upstream = await uniswapFetch("/swap", payload);
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      const clean = sanitizeUpstreamError(data, "Uniswap swap build failed.");
      return publicJson(
        clean,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    // CreateSwapResponse: { requestId, swap: TransactionRequest, gasFee }
    const swap = data.swap as Record<string, unknown> | undefined;
    if (!swap || typeof swap !== "object") {
      throw new TradeApiError(502, "BAD_TX", "Uniswap returned no swap transaction.");
    }
    if (
      typeof swap.to !== "string" ||
      typeof swap.data !== "string" ||
      !swap.data ||
      swap.data === "0x"
    ) {
      throw new TradeApiError(502, "BAD_TX", "Uniswap returned an invalid swap transaction.");
    }
    if (typeof swap.chainId === "number" && swap.chainId !== 4663) {
      throw new TradeApiError(502, "BAD_CHAIN", "Swap transaction is not for Robinhood Chain.");
    }

    return publicJson({
      requestId: data.requestId,
      swap,
      gasFee: data.gasFee,
    });
  } catch (err) {
    return publicError(err, "Unexpected error building swap.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
