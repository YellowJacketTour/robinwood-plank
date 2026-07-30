import { CHAIN, CONTRACT_ADDRESS } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet } from "@/lib/boards-store";
import {
  assertCrossChainSourceAllowed,
  assertNoClientFeeOrRouteOverride,
  assertSafeTransactionTarget,
  assertTradeOpen,
  CROSSCHAIN_SOURCE_CHAINS,
  extractFees,
  getPublicSiteFee,
  getSwapFeeParams,
  isNativeAddr,
  isZeroXConfigured,
  sanitizeZeroXError,
  TradeApiError,
  ZEROX_CROSSCHAIN_ENABLED,
  ZEROX_NATIVE_SENTINEL,
  zeroExFeeDisclosure,
  zeroxFetch,
} from "@/lib/zerox-server";
import type { ZeroXCrossChainQuoteResponse, ZeroXCrossChainStep } from "@/lib/zerox-types";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  sourceChainId?: unknown;
  sourceToken?: unknown;
  amount?: unknown;
  recipient?: unknown;
  slippageTolerance?: unknown;
};

/**
 * TRUE one-step cross-chain into $PLANK via 0x's Cross-Chain API.
 *
 * CONFIRMED WORKING (live quote, 2026-07-30, real ZEROX_API_KEY): ETH on
 * Ethereum mainnet (chainId 1) -> $PLANK on Robinhood Chain (4663) in a
 * single quote/transaction, `liquidityAvailable: true`, ~4s estimated
 * settlement. 0x's router found: swap ETH->USDT on mainnet, then bridge
 * USDT->$PLANK into Robinhood Chain via the "relay" provider — one signed
 * transaction on the source chain does the whole thing.
 *
 * This is the capability Uniswap's CHAINED (bridge+swap) routing does NOT
 * have: a live check against the Uniswap Trading API returns HTTP 404 "No
 * quotes available" for ETH(1)->PLANK(4663) and ETH(1)->USDG(4663) alike, so
 * today Uniswap can only get a user into Robinhood Chain via a plain bridge
 * (ETH->ETH) followed by a SEPARATE same-chain swap. 0x does it in one.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "zerox-xchain-quote", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!ZEROX_CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "ZEROX_CROSSCHAIN_DISABLED", "0x cross-chain buys are not enabled.");
    }
    if (!isZeroXConfigured()) {
      throw new TradeApiError(503, "NO_API_KEY", "0x API key is not configured on the server.");
    }

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    const sourceChainId =
      typeof body.sourceChainId === "number" ? body.sourceChainId : Number(body.sourceChainId);
    if (!Number.isFinite(sourceChainId)) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "sourceChainId must be a number.");
    }
    assertCrossChainSourceAllowed(sourceChainId);

    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer in base units.");
    }

    const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
    if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      throw new TradeApiError(400, "BAD_RECIPIENT", "recipient must be a valid wallet address.");
    }

    if (isSniperCaptureActive()) {
      const board = await classifyWallet(recipient);
      if (board.side === "bad_boards" || board.side === "fallen") {
        throw new TradeApiError(
          403,
          "BAD_BOARD",
          "This wallet is on Bad Boards from the death trap. Wait for free trade."
        );
      }
    }

    const sourceTokenRaw = typeof body.sourceToken === "string" ? body.sourceToken.trim() : "";
    if (sourceTokenRaw && !/^0x[a-fA-F0-9]{40}$/.test(sourceTokenRaw)) {
      throw new TradeApiError(400, "BAD_TOKEN", "sourceToken must be a token address.");
    }
    // v1: source side only supports the chain's native token — no per-source-
    // chain ERC-20 allowlist exists yet (same scoping lib/crosschain-constants.ts
    // uses for the Uniswap-bridge fallback). Reject anything else explicitly
    // rather than silently substituting native.
    if (sourceTokenRaw && !isNativeAddr(sourceTokenRaw)) {
      throw new TradeApiError(
        400,
        "UNSUPPORTED_SOURCE_TOKEN",
        "Only the source chain's native token is supported for cross-chain buys right now."
      );
    }

    const slippageTolerance =
      typeof body.slippageTolerance === "number" &&
      body.slippageTolerance > 0 &&
      body.slippageTolerance <= 50
        ? body.slippageTolerance
        : 1.0;

    const params: Record<string, string> = {
      originChain: String(sourceChainId),
      destinationChain: String(CHAIN.id),
      sellToken: ZEROX_NATIVE_SENTINEL,
      buyToken: CONTRACT_ADDRESS,
      sellAmount: amount,
      originAddress: recipient.toLowerCase(),
      destinationAddress: recipient.toLowerCase(),
      slippageBps: String(Math.round(slippageTolerance * 100)),
      sortQuotesBy: "price",
      maxNumQuotes: "1",
    };

    // Our affiliate fee — server-attached, 100% plank.love's. CONFIRMED via a
    // live quote (2026-07-30): unlike the same-chain Swap API (where
    // swapFeeToken may be either side), the Cross-Chain API rejects any
    // feeToken that isn't the ORIGIN-chain sellToken — "feeToken[0] must
    // match sellToken for origin chain fees". So the fee here is always
    // realized in the source chain's native token, not in $PLANK.
    const feeParams = getSwapFeeParams();
    if (feeParams) {
      params.feeBps = feeParams.swapFeeBps;
      params.feeRecipient = feeParams.swapFeeRecipient;
      params.feeToken = ZEROX_NATIVE_SENTINEL;
    }

    const upstream = await zeroxFetch("/cross-chain/quotes", params);
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const name = typeof data.name === "string" ? data.name : "";
      if (upstream.status === 429 || /rate.?limit|throttl/i.test(name)) {
        return publicJson(
          { error: "RATE_LIMIT", message: "0x routing is busy — wait a few seconds and try again." },
          429
        );
      }
      const clean = sanitizeZeroXError(data, "0x cross-chain quote request failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const liquidityAvailable = data.liquidityAvailable !== false;
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    if (!liquidityAvailable || quotes.length === 0) {
      return publicJson(
        {
          error: "NO_LIQUIDITY",
          message:
            "0x has no one-step cross-chain route into $PLANK from this chain right now. Try the bridge-then-swap flow instead.",
        },
        404
      );
    }

    const best = quotes[0] as Record<string, unknown>;

    // Fail-closed step validation — same posture as crosschain-server.ts's
    // assertPlanStepsSane: every step must target either the declared source
    // chain or Robinhood Chain, never a third chain a tampered/buggy response
    // could smuggle in.
    const rawSteps = Array.isArray(best.steps) ? best.steps : [];
    const steps: ZeroXCrossChainStep[] = [];
    for (const raw of rawSteps) {
      if (!raw || typeof raw !== "object") {
        throw new TradeApiError(502, "BAD_STEP", "0x cross-chain step is not an object.");
      }
      const step = raw as ZeroXCrossChainStep;
      const chainIds = [step.chainId, step.originChainId, step.destinationChainId].filter(
        (v): v is number => typeof v === "number"
      );
      for (const id of chainIds) {
        if (id !== sourceChainId && id !== CHAIN.id) {
          throw new TradeApiError(
            502,
            "BAD_STEP_CHAIN",
            `0x cross-chain step targets chain ${id}, which is neither the source chain nor Robinhood Chain — refusing to relay.`
          );
        }
      }
      steps.push(step);
    }

    const fees = extractFees(best.fees);
    const rawTx = best.transaction as Record<string, unknown> | undefined;
    let tx: { chainType: string; to: string; data: string; value: string; gas?: string } | null = null;
    if (rawTx) {
      const details = (rawTx.details ?? rawTx) as Record<string, unknown>;
      assertSafeTransactionTarget(details);
      const d = details as { to: string; data: string; value?: string; gas?: string };
      tx = {
        chainType: typeof rawTx.chainType === "string" ? rawTx.chainType : "evm",
        to: d.to,
        data: d.data,
        value: d.value ?? "0",
        gas: d.gas,
      };
    }

    const responseBody: ZeroXCrossChainQuoteResponse = {
      provider: "0x",
      liquidityAvailable: true,
      originChainId: sourceChainId,
      destinationChainId: CHAIN.id,
      sellToken: ZEROX_NATIVE_SENTINEL,
      buyToken: CONTRACT_ADDRESS,
      buyAmount: typeof best.buyAmount === "string" ? best.buyAmount : "0",
      minBuyAmount: typeof best.minBuyAmount === "string" ? best.minBuyAmount : undefined,
      sellAmount: typeof best.sellAmount === "string" ? best.sellAmount : amount,
      estimatedTimeSeconds:
        typeof best.estimatedTimeSeconds === "number" ? best.estimatedTimeSeconds : undefined,
      steps,
      fees,
      transaction: tx,
      siteFee: getPublicSiteFee(),
      zeroExFeeDisclosure: zeroExFeeDisclosure(fees),
    };

    return publicJson(responseBody);
  } catch (err) {
    return publicError(err, "Unexpected error building 0x cross-chain quote.");
  }
}

export function GET() {
  return publicJson({
    sourceChains: CROSSCHAIN_SOURCE_CHAINS.map((c) => ({ chainId: c.chainId, name: c.name })),
  });
}
