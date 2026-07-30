import { CHAIN, PERMIT2_ADDRESS } from "@/lib/constants";
import { INDICATIVE_SWAPPER } from "@/lib/uniswap-types";
import { assertTradeOpen, extractAmountOut, TradeApiError } from "@/lib/uniswap-server";
import {
  CROSSCHAIN_DEST_CHAIN_ID,
  CROSSCHAIN_DEST_TOKEN,
  CROSSCHAIN_ENABLED,
  CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
  findSourceChain,
} from "@/lib/crosschain-constants";
import {
  assertNoCrossChainOverride,
  assertSourceChainAllowed,
  crossChainFetch,
  getIntegratorFees,
} from "@/lib/crosschain-server";
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
  sourceChainId?: unknown;
  amount?: unknown;
  swapper?: unknown;
  slippageTolerance?: unknown;
};

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-quote", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }
    assertTradeOpen();

    const body = await readJsonBody<Body>(req);
    assertNoCrossChainOverride(body as Record<string, unknown>);

    const sourceChainIdRaw = body.sourceChainId;
    const sourceChainId =
      typeof sourceChainIdRaw === "number" ? sourceChainIdRaw : Number(sourceChainIdRaw);
    if (!Number.isFinite(sourceChainId)) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "sourceChainId is required.");
    }
    assertSourceChainAllowed(sourceChainId);
    const sourceChain = findSourceChain(sourceChainId);
    if (!sourceChain) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "Unsupported source chain.");
    }

    const amount = typeof body.amount === "string" ? body.amount.trim() : "";
    if (!amount || !/^\d+$/.test(amount) || amount === "0") {
      throw new TradeApiError(400, "BAD_AMOUNT", "amount must be a positive integer in base units.");
    }

    const requestedSwapper = typeof body.swapper === "string" ? body.swapper.trim() : "";
    if (requestedSwapper && !/^0x[a-fA-F0-9]{40}$/.test(requestedSwapper)) {
      throw new TradeApiError(400, "BAD_SWAPPER", "swapper must be a valid wallet address.");
    }
    const indicative = !requestedSwapper;
    const swapper = indicative ? INDICATIVE_SWAPPER : requestedSwapper;

    const slippageTolerance =
      typeof body.slippageTolerance === "number" &&
      body.slippageTolerance > 0 &&
      body.slippageTolerance <= 50
        ? body.slippageTolerance
        : 2.5;

    // v1: pay with the source chain's native token only. Widening to
    // arbitrary ERC-20s needs a per-chain allowlist mirroring
    // lib/uniswap-tokenlist.ts, which is out of scope here.
    const quoteBody: Record<string, unknown> = {
      tokenIn: CROSSCHAIN_NATIVE_TOKEN_ADDRESS,
      tokenOut: CROSSCHAIN_DEST_TOKEN,
      tokenInChainId: sourceChain.chainId,
      tokenOutChainId: CROSSCHAIN_DEST_CHAIN_ID,
      type: "EXACT_INPUT",
      amount,
      swapper: swapper.toLowerCase(),
      slippageTolerance,
      permitAmount: "EXACT",
      routingPreference: "BEST_PRICE",
    };

    const integratorFees = getIntegratorFees();
    if (integratorFees.length > 0) {
      quoteBody.integratorFees = integratorFees;
    }

    let upstream = await crossChainFetch("/quote", { method: "POST", body: quoteBody });
    let data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    // Fee behavior on CHAINED/BRIDGE routing is undocumented upstream — if
    // attaching integratorFees causes the quote itself to fail, retry once
    // without it rather than blocking the whole cross-chain flow on an
    // unverified fee interaction. Fails OPEN to "no fee", never to "wrong fee".
    if (!upstream.ok && integratorFees.length > 0) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const msg = typeof data.message === "string" ? data.message : "";
      if (/fee|integrator/i.test(detail + msg)) {
        const retryBody = { ...quoteBody };
        delete retryBody.integratorFees;
        upstream = await crossChainFetch("/quote", { method: "POST", body: retryBody });
        data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      }
    }

    if (!upstream.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const code = typeof data.errorCode === "string" ? data.errorCode : "";
      const msg = (typeof data.message === "string" && data.message) || detail || "";
      if (upstream.status === 429 || /rate.?limit|throttl|too many/i.test(msg + detail)) {
        return publicJson(
          { error: "RATE_LIMIT", message: "Routing is busy — wait a few seconds and try again." },
          429
        );
      }
      if (code === "ResourceNotFound" || /no quotes available/i.test(detail) || /no route/i.test(detail)) {
        return publicJson(
          {
            error: "NO_ROUTE",
            message: `No cross-chain route from ${sourceChain.name} to $PLANK on ${CHAIN.name} right now.`,
          },
          404
        );
      }
      const clean = sanitizeUpstreamError(data, detail || "Cross-chain quote request failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const routing = typeof data.routing === "string" ? data.routing : "";
    if (!["BRIDGE", "CHAINED"].includes(routing)) {
      throw new TradeApiError(
        502,
        "BAD_ROUTING",
        `Unexpected routing "${routing}" for a cross-chain request — refusing.`
      );
    }

    const quoteObj =
      data.quote && typeof data.quote === "object" ? (data.quote as Record<string, unknown>) : data;
    const amountOut = extractAmountOut(quoteObj);

    // Same belt-and-suspenders as the same-chain widget: an inline approval
    // tx may only target Permit2 or $PLANK.
    const permitTx = data.permitTransaction as { to?: unknown } | null | undefined;
    if (permitTx && typeof permitTx === "object" && typeof permitTx.to === "string") {
      const allowed = new Set([
        PERMIT2_ADDRESS.toLowerCase(),
        CROSSCHAIN_DEST_TOKEN.toLowerCase(),
      ]);
      if (!allowed.has(permitTx.to.toLowerCase())) {
        throw new TradeApiError(
          502,
          "BAD_SPENDER",
          "Quote approval target is not Permit2 or the $PLANK contract. Blocked for safety."
        );
      }
    }

    return publicJson({
      ...data,
      amountOut,
      routing,
      indicative,
      sourceChain: { chainId: sourceChain.chainId, name: sourceChain.name },
      destChain: { chainId: CROSSCHAIN_DEST_CHAIN_ID, name: CHAIN.name },
    });
  } catch (err) {
    return publicError(err, "Unexpected error building cross-chain quote.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
