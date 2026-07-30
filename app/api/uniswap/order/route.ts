import { CHAIN } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet, recordWidgetActivity } from "@/lib/boards-store";
import {
  assertNoClientFeeOrRouteOverride,
  assertOrderIntegrity,
  assertTradeOpen,
  isGaslessEnabled,
  TradeApiError,
  uniswapFetch,
  uniswapGetFetch,
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
  /** The exact, unmodified quote object returned by /api/uniswap/quote for
   * this Dutch/UniswapX route — re-validated here the same way /api/uniswap/swap
   * re-validates a CLASSIC quote before building a tx. */
  quote?: unknown;
  /** ABI-encoded UniswapX order, built client-side from quote.orderInfo. */
  encodedOrder?: unknown;
  /** EIP-712 signature over that encoded order. */
  signature?: unknown;
  swapper?: unknown;
};

/**
 * POST /api/uniswap/order — submit a signed UniswapX (gasless) order.
 *
 * Unlike /api/uniswap/swap, there is no separate fee parameter here: the fee
 * was already set via integratorFees on the preceding /api/uniswap/quote
 * call and is baked into the order's outputs (see assertOrderIntegrity),
 * which the client signs as-is. This route's job is purely to re-validate
 * that quote/order pairing and relay the already-signed order upstream.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "gasless-order", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!isGaslessEnabled()) {
      throw new TradeApiError(403, "GASLESS_DISABLED", "Gasless swaps are not enabled yet.");
    }

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    if (!body.quote || typeof body.quote !== "object" || Array.isArray(body.quote)) {
      throw new TradeApiError(400, "BAD_QUOTE", "quote object is required.");
    }
    const encodedOrder = typeof body.encodedOrder === "string" ? body.encodedOrder.trim() : "";
    const signature = typeof body.signature === "string" ? body.signature.trim() : "";
    if (!encodedOrder || !encodedOrder.startsWith("0x")) {
      throw new TradeApiError(400, "BAD_ORDER", "encodedOrder must be an encoded order hex string.");
    }
    if (!signature || !signature.startsWith("0x")) {
      throw new TradeApiError(400, "BAD_SIGNATURE", "signature must be a hex signature.");
    }

    const quote = body.quote as Record<string, unknown>;
    // Same standard as /api/uniswap/swap's assertQuoteIntegrity: pair, chain,
    // and fee wallet must still be ours, plus the Dutch-specific reactor /
    // output-recipient checks — this is what stands between "the client
    // signed something" and "the client signed the exact order we quoted".
    await assertOrderIntegrity(quote);

    const swapper =
      typeof body.swapper === "string"
        ? body.swapper.trim()
        : typeof (quote as { swapper?: string }).swapper === "string"
          ? String((quote as { swapper?: string }).swapper)
          : "";

    if (!swapper || !/^0x[a-fA-F0-9]{40}$/.test(swapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }

    if (isSniperCaptureActive()) {
      const board = await classifyWallet(swapper);
      if (board.side === "bad_boards" || board.side === "fallen") {
        throw new TradeApiError(
          403,
          "BAD_BOARD",
          "This wallet is on Bad Boards from the death trap. Wait for free trade."
        );
      }
    }

    const quoteId = typeof quote.quoteId === "string" ? quote.quoteId : undefined;
    const requestId = typeof quote.requestId === "string" ? quote.requestId : undefined;
    const routing = typeof quote.routing === "string" ? quote.routing : "";

    const orderBody: Record<string, unknown> = {
      encodedOrder,
      signature,
      chainId: CHAIN.id,
      // Uniswap's order service expects the routing/order-type vocabulary it
      // itself returned on the quote (e.g. "DUTCH_V2") — pass it straight
      // through rather than re-deriving a different casing.
      orderType: routing,
      ...(quoteId ? { quoteId } : {}),
      ...(requestId ? { requestId } : {}),
    };

    const upstream = await uniswapFetch("/order", orderBody);
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const detail =
        (typeof data.detail === "string" && data.detail) ||
        (typeof data.message === "string" && data.message) ||
        "";
      if (upstream.status === 429 || /rate.?limit|throttl|too many/i.test(detail)) {
        return publicJson(
          { error: "RATE_LIMIT", message: "Order routing is busy — wait a few seconds and retry." },
          429
        );
      }
      const clean = sanitizeUpstreamError(data, detail || "UniswapX order submission failed.");
      return publicJson(
        clean,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    await recordWidgetActivity(swapper, "swap");

    // orderHash is what the client polls with via GET below.
    const orderHash =
      (typeof data.orderHash === "string" && data.orderHash) ||
      (typeof data.orderId === "string" && data.orderId) ||
      null;

    return publicJson({
      orderHash,
      orderStatus: (typeof data.orderStatus === "string" && data.orderStatus) || "open",
      chainId: CHAIN.id,
    });
  } catch (err) {
    return publicError(err, "Unexpected error submitting gasless order.");
  }
}

/**
 * GET /api/uniswap/order?orderHash=0x...&swapper=0x... — poll status of a
 * previously submitted UniswapX order. Read-only, no fee/pair surface, so
 * it's a much lighter check than POST: rate limit + shape validation only.
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "gasless-order-status", limit: 180, windowMs: 60_000 });
    if (limited) return limited;

    if (!isGaslessEnabled()) {
      throw new TradeApiError(403, "GASLESS_DISABLED", "Gasless swaps are not enabled yet.");
    }

    const url = new URL(req.url);
    const orderHash = url.searchParams.get("orderHash")?.trim() || "";
    const swapper = url.searchParams.get("swapper")?.trim() || "";

    if (!orderHash || !orderHash.startsWith("0x")) {
      throw new TradeApiError(400, "BAD_ORDER_HASH", "orderHash query param is required.");
    }
    if (swapper && !/^0x[a-fA-F0-9]{40}$/.test(swapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }

    const upstream = await uniswapGetFetch("/orders", {
      orderHash,
      chainId: String(CHAIN.id),
      ...(swapper ? { swapper } : {}),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const clean = sanitizeUpstreamError(data, "Could not fetch order status.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    // Uniswap's /orders returns { orders: [...] } — surface just the one we asked for.
    const orders = Array.isArray(data.orders) ? data.orders : [];
    const order = (orders[0] as Record<string, unknown> | undefined) || null;

    return publicJson({
      orderHash,
      // Open | Expired | Error | Cancelled | Filled | Insufficient-funds | Unverified
      orderStatus: (order && typeof order.orderStatus === "string" && order.orderStatus) || "Unverified",
      txHash: (order && typeof order.txHash === "string" && order.txHash) || null,
    });
  } catch (err) {
    return publicError(err, "Unexpected error fetching order status.");
  }
}
