import { CHAIN } from "@/lib/constants";
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
        "Not enough ETH (buy) or PLANK/allowance (sell) for this swap. Add funds or lower the amount.",
      status: 400,
    };
  }
  if (/FAILED_TO_ESTIMATE_GAS|gas fee|simulate/i.test(m)) {
    return {
      error: "GAS_ESTIMATE",
      message:
        "Wallet simulation could not estimate gas. Get a fresh quote and retry — ensure you have ETH for gas.",
      status: 502,
    };
  }
  if (/rate.?limit|too many|throttl|429/i.test(m)) {
    return {
      error: "RATE_LIMIT",
      message: "Routing is busy — wait a few seconds and get a fresh quote.",
      status: 429,
    };
  }
  return {
    error: "SWAP_BUILD",
    message: m.slice(0, 280) || "Could not build swap. Get a fresh quote and try again.",
    status: 502,
  };
}

/**
 * Normalize Uniswap TransactionRequest for wallet simulators (Rabby/MetaMask).
 * Critical: do NOT mix gasPrice with maxFeePerGas — that breaks Rabby simulation.
 * Prefer letting the wallet estimate fees; keep gas limit only if Uniswap provided it.
 */
function walletSafeTx(swap: SwapTx, from: string): SwapTx {
  const to = typeof swap.to === "string" ? swap.to : "";
  const data = typeof swap.data === "string" ? swap.data : "";
  let value = swap.value;
  if (typeof value === "number") value = `0x${BigInt(value).toString(16)}`;
  if (typeof value === "string" && value && !value.startsWith("0x")) {
    try {
      value = `0x${BigInt(value).toString(16)}`;
    } catch {
      value = "0x0";
    }
  }

  const out: SwapTx = {
    to,
    data,
    from,
    chainId: CHAIN.id,
  };
  if (value) out.value = value;

  // Keep only a gas *limit* if present (not fee fields)
  const rawGas = swap.gasLimit ?? swap.gas;
  if (rawGas != null && rawGas !== "") {
    try {
      const n =
        typeof rawGas === "string" && rawGas.startsWith("0x")
          ? BigInt(rawGas)
          : BigInt(rawGas);
      // mild headroom without over-insisting
      const bumped = (n * BigInt(115)) / BigInt(100);
      out.gas = `0x${bumped.toString(16)}`;
      out.gasLimit = out.gas;
    } catch {
      /* omit — wallet estimates */
    }
  }

  // Intentionally omit gasPrice / maxFeePerGas / maxPriorityFeePerGas.
  // Rabby + modern wallets simulate and set fees themselves; forced fees
  // cause "simulation failed" and worse inclusion than Uniswap.app.
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

    /**
     * Prefer NO server-side simulation — Rabby re-simulates in-wallet.
     * Uniswap sim often fails (gas fee / TRANSFER) while the real tx is fine.
     * refreshGasPrice true once for better inclusion without embedding fees in tx.
     */
    const attempts: Array<Record<string, unknown>> = [
      { ...basePayload, refreshGasPrice: true, simulateTransaction: false },
      { ...basePayload, refreshGasPrice: false, simulateTransaction: false },
      // last resort: with sim (some keys require it)
      { ...basePayload, refreshGasPrice: true, simulateTransaction: true },
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

    const from = swapper || (typeof rawSwap.from === "string" ? rawSwap.from : "");
    const swap = walletSafeTx(rawSwap, from);

    if (swapper) {
      await recordWidgetActivity(swapper, "swap");
    }

    return publicJson({
      requestId: data.requestId,
      swap,
      // gasFee is informational only — not forced onto the tx
      gasFee: data.gasFee ?? null,
      walletSim: true,
    });
  } catch (err) {
    return publicError(err, "Unexpected error building swap.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
