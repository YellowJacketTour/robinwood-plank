import { TradeApiError } from "@/lib/uniswap-server";
import { CROSSCHAIN_ENABLED } from "@/lib/crosschain-constants";
import { assertBridgeDestinationNative, crossChainFetch } from "@/lib/crosschain-server";
import { publicError, publicJson, rateLimit, readJsonBody, sanitizeUpstreamError } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  quote?: unknown;
};

/**
 * Build the single origin-chain transaction for a BRIDGE-routed quote.
 * Confirmed live: this is the SAME /swap call shape as the same-chain
 * widget uses (to/data/value/gas/maxFeePerGas), not a multi-step /plan —
 * BRIDGE routing settles through one signed transaction on the source
 * chain, and the bridge (Across, via Uniswap) delivers native ETH on
 * Robinhood Chain without any further action from the user.
 *
 * RESIDUAL RISK (documented, not hidden): unlike the same-chain widget,
 * which pins tx.to to the one known Universal Router address, this
 * transaction's target varies by source chain (a different bridge
 * contract per chain) and is not individually pinned here. The mitigation
 * is that this tx only ever comes from Uniswap's own /swap response for a
 * quote WE built server-side and re-validated (assertBridgeDestinationNative)
 * — the same trust boundary as every other Uniswap-sourced transaction in
 * this codebase, just without a single fixed address to check it against.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-bridge-swap", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const quote = body.quote;
    if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
      throw new TradeApiError(400, "BAD_QUOTE", "quote object is required.");
    }
    const quoteWrapper = quote as Record<string, unknown>;
    const quoteObj =
      quoteWrapper.quote && typeof quoteWrapper.quote === "object"
        ? (quoteWrapper.quote as Record<string, unknown>)
        : quoteWrapper;
    assertBridgeDestinationNative(quoteObj);

    const routing = typeof quoteWrapper.routing === "string" ? quoteWrapper.routing : "";
    if (routing !== "BRIDGE") {
      throw new TradeApiError(400, "BAD_ROUTING", "This endpoint only executes BRIDGE-routed quotes.");
    }

    const upstream = await crossChainFetch("/swap", { method: "POST", body: { quote: quoteObj } });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const clean = sanitizeUpstreamError(data, detail || "Could not build the bridge transaction.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const swap = data.swap as Record<string, unknown> | undefined;
    if (!swap || typeof swap.to !== "string" || typeof swap.data !== "string") {
      throw new TradeApiError(502, "BAD_SWAP", "Bridge swap response missing a transaction.");
    }

    return publicJson({ swap: data.swap, gasFee: data.gasFee });
  } catch (err) {
    return publicError(err, "Unexpected error building the bridge transaction.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
