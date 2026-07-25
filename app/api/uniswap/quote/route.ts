import { CHAIN } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet, recordWidgetActivity } from "@/lib/boards-store";
import {
  AMM_PROTOCOLS,
  assertAllowedPair,
  assertNoClientFeeOrRouteOverride,
  assertTradeOpen,
  attachPublicFeeMeta,
  extractAmountOut,
  getIntegratorFees,
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

    // Only block Bad Boards during active death trap (not free community trade)
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

    const { tokenIn, tokenOut } = resolveTokens(direction);
    assertAllowedPair(tokenIn, tokenOut, CHAIN.id);

    // Spec-accurate fee payload (OpenAPI IntegratorFee + integratorFees array).
    const integratorFees = getIntegratorFees();

    const upstream = await uniswapFetch("/quote", {
      tokenIn,
      tokenOut,
      tokenInChainId: CHAIN.id,
      tokenOutChainId: CHAIN.id,
      type: "EXACT_INPUT",
      amount,
      swapper: swapper.toLowerCase(),
      slippageTolerance,
      permitAmount: "EXACT",
      // AMM only → CLASSIC quotes → /swap (not UniswapX /order)
      protocols: [...AMM_PROTOCOLS],
      routingPreference: "BEST_PRICE",
      integratorFees,
    });

    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      // Map common Uniswap errors to clear community-facing messages
      const detail = typeof data.detail === "string" ? data.detail : "";
      const code = typeof data.errorCode === "string" ? data.errorCode : "";
      if (
        code === "ResourceNotFound" ||
        /no quotes available/i.test(detail) ||
        /no route/i.test(detail)
      ) {
        return publicJson(
          {
            error: "NO_LIQUIDITY",
            message:
              "No Uniswap route for $PLANK yet. LP may not be live — wait for the official pool on Robinhood Chain.",
          },
          404
        );
      }
      const clean = sanitizeUpstreamError(data, detail || "Uniswap quote request failed.");
      return publicJson(
        clean,
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    const routing = typeof data.routing === "string" ? data.routing : "";
    if (routing && !["CLASSIC", "WRAP", "UNWRAP"].includes(routing)) {
      throw new TradeApiError(
        502,
        "BAD_ROUTING",
        `Unexpected routing "${routing}". Retry — official widget requires AMM (CLASSIC).`
      );
    }

    const quoteObj =
      data.quote && typeof data.quote === "object"
        ? (data.quote as Record<string, unknown>)
        : data;
    const amountOut = extractAmountOut(quoteObj);

    // Official widget path — keep this wallet off Bad Boards auto-list
    const session = await recordWidgetActivity(swapper, "quote");
    const board = await classifyWallet(swapper);

    return publicJson(
      attachPublicFeeMeta({
        ...data,
        amountOut,
        boards: {
          widgetVerified: true,
          side: board.side,
          cooldown: board.cooldown,
          session,
        },
      })
    );
  } catch (err) {
    return publicError(err, "Unexpected error building quote.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
