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

    // Never accept client-supplied integratorFee nested under quote overrides for rebuild.
    // We pass the quote through as returned by Uniswap; integrity check enforces fee recipient.

    const payload: Record<string, unknown> = { quote };
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
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    // Only return fields needed to sign/send — never env or headers.
    const swap =
      (data.swap as Record<string, unknown> | undefined) ||
      (data.transaction as Record<string, unknown> | undefined);

    if (swap && typeof swap === "object") {
      // Validate tx shape before handing to wallet
      if (typeof swap.to !== "string" || typeof swap.data !== "string" || !swap.data || swap.data === "0x") {
        throw new TradeApiError(502, "BAD_TX", "Uniswap returned an invalid swap transaction.");
      }
    }

    return publicJson(data);
  } catch (err) {
    return publicError(err, "Unexpected error building swap.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
