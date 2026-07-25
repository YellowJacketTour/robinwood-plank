import { CHAIN } from "@/lib/constants";
import { isSniperCaptureActive } from "@/lib/boards";
import { classifyWallet, recordWidgetActivity } from "@/lib/boards-store";
import { ROBINHOOD_RPC_URLS } from "@/lib/mint-contract";
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
  value?: string;
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
        "Could not estimate gas (pool busy or balance/allowance issue). Retry in a few seconds with a smaller amount.",
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

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  let last: unknown;
  for (const url of ROBINHOOD_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        cache: "no-store",
      });
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (data.error) throw new Error(data.error.message || "RPC error");
      return data.result;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("RPC failed");
}

/** Fill missing gas fields from Robinhood Chain so the wallet can still send. */
async function ensureGasFields(swap: SwapTx, from: string): Promise<SwapTx> {
  const next = { ...swap };
  const hasGas = Boolean(next.gasLimit || next.gas);
  const hasPrice = Boolean(
    next.gasPrice || (next.maxFeePerGas && next.maxPriorityFeePerGas)
  );

  if (!hasGas && next.to && next.data) {
    try {
      const est = (await rpc("eth_estimateGas", [
        {
          from,
          to: next.to,
          data: next.data,
          value:
            typeof next.value === "string" && next.value
              ? next.value.startsWith("0x")
                ? next.value
                : `0x${BigInt(next.value).toString(16)}`
              : "0x0",
        },
      ])) as string;
      if (est) {
        // +20% headroom
        const n = BigInt(est);
        const bumped = (n * 12n) / 10n;
        next.gasLimit = `0x${bumped.toString(16)}`;
        next.gas = next.gasLimit;
      }
    } catch {
      // wallet will estimate
    }
  }

  if (!hasPrice) {
    try {
      const gp = (await rpc("eth_gasPrice", [])) as string;
      if (gp) {
        next.gasPrice = gp;
        // mild EIP-1559-ish fields for wallets that prefer them
        const price = BigInt(gp);
        next.maxFeePerGas = `0x${((price * 12n) / 10n).toString(16)}`;
        next.maxPriorityFeePerGas = `0x${(price / 10n || 1n).toString(16)}`;
      }
    } catch {
      /* wallet fills */
    }
  }

  if (typeof next.chainId !== "number") {
    next.chainId = CHAIN.id;
  }
  return next;
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
    // Launch traffic: generous limits (was 20 — too tight with quote+swap+retries)
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

    // Attempt order: simulate+refresh → refresh only → neither (wallet estimates gas)
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
      // Only retry gas/sim/rate-limit style failures
      if (!isGasFailure(result.message) && result.status !== 429) {
        const mapped = mapSwapError(result.message);
        return publicJson(
          { error: mapped.error, message: mapped.message },
          mapped.status
        );
      }
      // brief backoff on rate limit
      if (result.status === 429 || /rate.?limit/i.test(result.message)) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    if (!data) {
      const mapped = mapSwapError(lastFail);
      return publicJson(
        { error: mapped.error, message: mapped.message },
        lastStatus === 429 ? 429 : mapped.status
      );
    }

    let swap = data.swap as SwapTx | undefined;
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

    // Ensure gas so wallets don't fail on "missing gas" after Uniswap skips it
    if (swapper) {
      swap = await ensureGasFields(swap, swapper);
    }

    if (swapper) {
      await recordWidgetActivity(swapper, "swap");
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
