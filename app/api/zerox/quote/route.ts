import { CHAIN } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet, recordWidgetActivity } from "@/lib/boards-store";
import {
  assertNoClientFeeOrRouteOverride,
  assertSafeTransactionTarget,
  assertTradeOpen,
  extractFees,
  getPublicSiteFee,
  getSwapFeeParams,
  isZeroXConfigured,
  resolveAllowedCounter,
  resolveTokens,
  sanitizeZeroXError,
  TradeApiError,
  ZEROX_ENABLED,
  zeroExFeeDisclosure,
  zeroxFetch,
} from "@/lib/zerox-server";
import { ZEROX_INDICATIVE_SWAPPER } from "@/lib/zerox-types";
import type { ZeroXDirection } from "@/lib/zerox-server";
import type { ZeroXQuoteResponse } from "@/lib/zerox-types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  direction?: unknown;
  amount?: unknown;
  swapper?: unknown;
  slippageTolerance?: unknown;
  counterToken?: unknown;
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "zerox-quote", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    // Feature is OFF by default and MUST be a clean no-op when off — same
    // gate shape as GASLESS_SWAPS_ENABLED / CROSSCHAIN_ENABLED.
    if (!ZEROX_ENABLED) {
      throw new TradeApiError(404, "ZEROX_DISABLED", "0x quoting is not enabled.");
    }
    if (!isZeroXConfigured()) {
      throw new TradeApiError(503, "NO_API_KEY", "0x API key is not configured on the server.");
    }

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    const direction: ZeroXDirection = body.direction === "sell" ? "sell" : "buy";
    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    const requestedSwapper = typeof body.swapper === "string" ? body.swapper.trim() : "";
    const slippageTolerance =
      typeof body.slippageTolerance === "number" &&
      body.slippageTolerance > 0 &&
      body.slippageTolerance <= 50
        ? body.slippageTolerance
        : 1.0;

    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer in base units.");
    }
    if (requestedSwapper && !/^0x[a-fA-F0-9]{40}$/.test(requestedSwapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }
    const indicative = !requestedSwapper;
    const swapper = indicative ? ZEROX_INDICATIVE_SWAPPER : requestedSwapper;

    if (!indicative && isSniperCaptureActive()) {
      const board = await classifyWallet(swapper);
      if (board.side === "bad_boards" || board.side === "fallen") {
        throw new TradeApiError(
          403,
          "BAD_BOARD",
          "This wallet is on Bad Boards from the death trap. Wait for free trade."
        );
      }
    }

    const counterRaw = typeof body.counterToken === "string" ? body.counterToken.trim() : "";
    let counter: { address: string; decimals: number } | undefined;
    if (counterRaw) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(counterRaw)) {
        throw new TradeApiError(400, "BAD_TOKEN", "counterToken must be a token address.");
      }
      counter = await resolveAllowedCounter(counterRaw);
    }

    const { tokenIn, tokenOut } = resolveTokens(direction, counter);

    const params: Record<string, string> = {
      chainId: String(CHAIN.id),
      sellToken: tokenIn,
      buyToken: tokenOut,
      sellAmount: amount,
      taker: swapper.toLowerCase(),
      slippageBps: String(Math.round(slippageTolerance * 100)),
    };

    // Our affiliate fee — server-attached, 100% plank.love's. Realized on the
    // output (buyToken) side, same convention as the Uniswap integration.
    const feeParams = getSwapFeeParams();
    if (feeParams) {
      params.swapFeeBps = feeParams.swapFeeBps;
      params.swapFeeRecipient = feeParams.swapFeeRecipient;
      params.swapFeeToken = tokenOut;
    }

    const upstream = await zeroxFetch("/swap/allowance-holder/quote", params);
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const name = typeof data.name === "string" ? data.name : "";
      if (upstream.status === 429 || /rate.?limit|throttl/i.test(name)) {
        return publicJson(
          { error: "RATE_LIMIT", message: "0x routing is busy — wait a few seconds and try again." },
          429
        );
      }
      if (/TOKEN_NOT_SUPPORTED|SWAP_VALIDATION_FAILED/i.test(name)) {
        return publicJson(
          {
            error: "NO_LIQUIDITY",
            message: "No 0x route for this pair yet on Robinhood Chain.",
          },
          404
        );
      }
      const clean = sanitizeZeroXError(data, "0x quote request failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const liquidityAvailable = data.liquidityAvailable !== false;
    if (!liquidityAvailable) {
      return publicJson(
        {
          error: "NO_LIQUIDITY",
          message: "No 0x route for $PLANK yet on Robinhood Chain.",
        },
        404
      );
    }

    const fees = extractFees(data.fees);
    const rawTx = data.transaction;
    if (rawTx) {
      assertSafeTransactionTarget(rawTx);
    }
    const tx = rawTx as { to: string; data: string; value?: string; gas?: string; gasPrice?: string } | undefined;

    const responseBody: ZeroXQuoteResponse = {
      provider: "0x",
      liquidityAvailable: true,
      buyAmount: typeof data.buyAmount === "string" ? data.buyAmount : "0",
      minBuyAmount: typeof data.minBuyAmount === "string" ? data.minBuyAmount : undefined,
      sellAmount: typeof data.sellAmount === "string" ? data.sellAmount : amount,
      sellToken: tokenIn,
      buyToken: tokenOut,
      indicative,
      fees,
      transaction: tx
        ? { to: tx.to, data: tx.data, value: tx.value ?? "0", gas: tx.gas, gasPrice: tx.gasPrice }
        : null,
      allowanceTarget: typeof data.allowanceTarget === "string" ? data.allowanceTarget : null,
      issues: (data.issues as Record<string, unknown>) ?? undefined,
      siteFee: getPublicSiteFee(),
      zeroExFeeDisclosure: zeroExFeeDisclosure(fees),
    };

    if (!indicative) {
      await recordWidgetActivity(swapper, "quote");
    }

    return publicJson(responseBody);
  } catch (err) {
    return publicError(err, "Unexpected error building 0x quote.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
