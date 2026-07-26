import { CHAIN, UNIVERSAL_ROUTER_ADDRESS } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet, recordWidgetActivity } from "@/lib/boards-store";
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
  swapper?: unknown;
};

type SwapTx = Record<string, unknown> & {
  to?: string;
  data?: string;
  value?: string | number;
  from?: string;
  gas?: string | number;
  gasLimit?: string | number;
  maxFeePerGas?: string | number;
  maxPriorityFeePerGas?: string | number;
  gasPrice?: string | number;
  chainId?: number | string;
};

const MIN_SWAP_GAS = BigInt(650_000);

function isGasFailure(message: string): boolean {
  return /gas fee|FAILED_TO_ESTIMATE_GAS|estimate.?gas|simulate transaction|TRANSFER_FAILED|rate.?limit|too many requests|throttl/i.test(
    message
  );
}

function mapSwapError(message: string): { error: string; message: string; status: number } {
  const m = message || "";
  if (/TRANSFER_FAILED|insufficient|exceeds balance/i.test(m)) {
    return {
      error: "INSUFFICIENT_FUNDS",
      message:
        "Not enough ETH (buy) or PLANK/allowance (sell). Leave ~0.002+ ETH for gas.",
      status: 400,
    };
  }
  if (/FAILED_TO_ESTIMATE_GAS|gas fee|simulate/i.test(m)) {
    return {
      error: "GAS_ESTIMATE",
      message:
        "Gas estimate failed. Fresh quote, leave ETH for gas, retry. Sell path may need approve first.",
      status: 502,
    };
  }
  if (/rate.?limit|too many|throttl|429/i.test(m)) {
    return {
      error: "RATE_LIMIT",
      message: "Routing busy — wait a few seconds and get a fresh quote.",
      status: 429,
    };
  }
  return {
    error: "SWAP_BUILD",
    message: m.slice(0, 280) || "Could not build swap. Fresh quote and retry.",
    status: 502,
  };
}

function parseQty(raw: unknown): bigint | null {
  if (raw === undefined || raw === null || raw === "") return null;
  try {
    if (typeof raw === "number") return BigInt(Math.floor(raw));
    const s = String(raw);
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * Pass through Uniswap tx with RH-safe gas limit.
 * Include Uniswap EIP-1559 fee fields as hex (they often come as decimal strings).
 * Client may re-estimate on wallet RPC.
 */
function walletSafeTx(swap: SwapTx, from: string, quote?: Record<string, unknown>): SwapTx {
  const to = typeof swap.to === "string" ? swap.to : "";
  const data = typeof swap.data === "string" ? swap.data : "";

  let value: string | undefined;
  const v = parseQty(swap.value);
  if (v !== null) {
    value = `0x${v.toString(16)}`;
  }

  // Gas limit from swap or quote.gasUseEstimate / gasEstimates
  let gasN =
    parseQty(swap.gasLimit) ||
    parseQty(swap.gas) ||
    parseQty(quote?.gasUseEstimate) ||
    null;

  const ge = quote?.gasEstimates;
  if (!gasN && Array.isArray(ge) && ge[0] && typeof ge[0] === "object") {
    gasN = parseQty((ge[0] as { gasLimit?: unknown }).gasLimit);
  }

  if (!gasN) gasN = MIN_SWAP_GAS;
  // +60% then floor 550k — UR + integrator fee burns more than Uniswap's ~135k sell estimate
  gasN = (gasN * BigInt(160)) / BigInt(100);
  if (gasN < MIN_SWAP_GAS) gasN = MIN_SWAP_GAS;
  if (gasN > BigInt(3_000_000)) gasN = BigInt(3_000_000);

  const out: SwapTx = {
    to,
    data,
    from,
    chainId: CHAIN.id,
    gas: `0x${gasN.toString(16)}`,
    gasLimit: `0x${gasN.toString(16)}`,
  };
  if (value !== undefined) out.value = value;

  // Prefer Uniswap eip1559 from swap or quote (decimal → hex)
  const maxFee =
    parseQty(swap.maxFeePerGas) ||
    parseQty(quote?.maxFeePerGas) ||
    (Array.isArray(ge) && ge[0]
      ? parseQty((ge[0] as { maxFeePerGas?: unknown }).maxFeePerGas)
      : null);
  const tip =
    parseQty(swap.maxPriorityFeePerGas) ||
    parseQty(quote?.maxPriorityFeePerGas) ||
    (Array.isArray(ge) && ge[0]
      ? parseQty((ge[0] as { maxPriorityFeePerGas?: unknown }).maxPriorityFeePerGas)
      : null);

  if (maxFee && tip && maxFee >= tip) {
    // +30% for inclusion on RH; client will also max() with live baseFee
    out.maxFeePerGas = `0x${((maxFee * BigInt(130)) / BigInt(100)).toString(16)}`;
    out.maxPriorityFeePerGas = `0x${((tip * BigInt(130)) / BigInt(100)).toString(16)}`;
  } else {
    const gp = parseQty(swap.gasPrice) || parseQty(quote?.gasPrice);
    if (gp) {
      out.gasPrice = `0x${((gp * BigInt(130)) / BigInt(100)).toString(16)}`;
    }
  }

  return out;
}

async function buildSwapOnce(
  payload: Record<string, unknown>
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string; status: number }> {
  const upstream = await uniswapFetch("/swap", payload);
  const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!upstream.ok) {
    const clean = sanitizeUpstreamError(data, "Uniswap swap build failed.");
    const detail =
      (typeof data.detail === "string" && data.detail) ||
      (typeof data.message === "string" && data.message) ||
      clean.message;
    return {
      ok: false,
      message: detail,
      status: upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
    };
  }
  return { ok: true, data };
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "swap", limit: 90, windowMs: 60_000 });
    if (limited) return limited;

    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoClientFeeOrRouteOverride(body as Record<string, unknown>);

    if (!body.quote || typeof body.quote !== "object" || Array.isArray(body.quote)) {
      throw new TradeApiError(400, "BAD_QUOTE", "quote object is required.");
    }

    const quote = body.quote as Record<string, unknown>;
    assertQuoteIntegrity(quote);

    const swapper =
      typeof body.swapper === "string"
        ? body.swapper.trim()
        : typeof (quote as { swapper?: string }).swapper === "string"
          ? String((quote as { swapper?: string }).swapper)
          : "";

    if (swapper && isSniperCaptureActive()) {
      const board = await classifyWallet(swapper);
      if (board.side === "bad_boards" || board.side === "fallen") {
        throw new TradeApiError(
          403,
          "BAD_BOARD",
          "Wallet is on Bad Boards during the death trap."
        );
      }
    }

    const basePayload: Record<string, unknown> = { quote };
    if (
      body.permitData &&
      typeof body.permitData === "object" &&
      typeof body.signature === "string" &&
      body.signature.length > 0
    ) {
      basePayload.permitData = body.permitData;
      basePayload.signature = body.signature;
    }

    // Prefer simulated builds when API can; fall back to no-sim so wallet still gets calldata.
    // Gas floor on walletSafeTx still protects against OOG (seen ~171k limits on failed buys).
    const attempts: Array<Record<string, unknown>> = [
      { ...basePayload, refreshGasPrice: true, simulateTransaction: true },
      { ...basePayload, refreshGasPrice: true, simulateTransaction: false },
      { ...basePayload, refreshGasPrice: false, simulateTransaction: false },
    ];

    let data: Record<string, unknown> | null = null;
    let lastFail = "";
    let lastStatus = 502;

    for (const payload of attempts) {
      const result = await buildSwapOnce(payload);
      if (result.ok) {
        data = result.data;
        break;
      }
      lastFail = result.message;
      lastStatus = result.status;
      if (!isGasFailure(result.message) && result.status !== 429) {
        const mapped = mapSwapError(result.message);
        return publicJson(
          { error: mapped.error, message: mapped.message },
          mapped.status
        );
      }
      if (result.status === 429 || /rate.?limit/i.test(result.message)) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    if (!data) {
      const mapped = mapSwapError(lastFail);
      return publicJson(
        { error: mapped.error, message: mapped.message },
        lastStatus === 429 ? 429 : mapped.status
      );
    }

    const rawSwap = data.swap as SwapTx | undefined;
    if (!rawSwap || typeof rawSwap !== "object") {
      throw new TradeApiError(502, "BAD_TX", "Uniswap returned no swap transaction.");
    }
    if (
      typeof rawSwap.to !== "string" ||
      typeof rawSwap.data !== "string" ||
      !rawSwap.data ||
      rawSwap.data === "0x"
    ) {
      throw new TradeApiError(502, "BAD_TX", "Uniswap returned an invalid swap transaction.");
    }
    if (typeof rawSwap.chainId === "number" && rawSwap.chainId !== 4663) {
      throw new TradeApiError(502, "BAD_CHAIN", "Swap transaction is not for Robinhood Chain.");
    }
    // Never hand the client a bridge / unknown router
    if (
      typeof rawSwap.to === "string" &&
      rawSwap.to.toLowerCase() !== UNIVERSAL_ROUTER_ADDRESS.toLowerCase()
    ) {
      throw new TradeApiError(
        502,
        "BAD_ROUTER",
        "Swap target is not Uniswap Universal Router on Robinhood Chain. Blocked for safety."
      );
    }

    const from = swapper || (typeof rawSwap.from === "string" ? rawSwap.from : "");
    const swap = walletSafeTx(rawSwap, from, quote);

    if (swapper) {
      await recordWidgetActivity(swapper, "swap");
    }

    return publicJson({
      requestId: data.requestId,
      swap,
      gasFee: data.gasFee ?? quote.gasFee ?? null,
      // Pass quote gas hints for client re-pricing
      gasHints: {
        maxFeePerGas: quote.maxFeePerGas ?? null,
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas ?? null,
        gasUseEstimate: quote.gasUseEstimate ?? null,
        gasEstimates: quote.gasEstimates ?? null,
      },
    });
  } catch (err) {
    return publicError(err, "Unexpected error building swap.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
