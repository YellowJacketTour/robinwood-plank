import { TradeApiError } from "@/lib/uniswap-server";
import { CROSSCHAIN_ENABLED } from "@/lib/crosschain-constants";
import {
  assertCrossChainDestination,
  assertPlanStepsSane,
  crossChainFetch,
} from "@/lib/crosschain-server";
import { publicError, publicJson, rateLimit, readJsonBody, sanitizeUpstreamError } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  quote?: unknown;
  routing?: unknown;
  sourceChainId?: unknown;
};

/**
 * Create a plan from a quote returned by /api/crosschain/quote. The quote
 * object is opaque to us but its destination fields are re-validated here —
 * same reasoning as assertQuoteIntegrity in lib/uniswap-server.ts: never
 * trust that a client-round-tripped quote still points where it did when we
 * issued it.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-plan", limit: 30, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const quote = body.quote;
    if (!quote || typeof quote !== "object" || Array.isArray(quote)) {
      throw new TradeApiError(400, "BAD_QUOTE", "quote object is required.");
    }
    const quoteObj = quote as Record<string, unknown>;
    assertCrossChainDestination(quoteObj);

    const routing = typeof body.routing === "string" ? body.routing : "";
    if (!["BRIDGE", "CHAINED"].includes(routing)) {
      throw new TradeApiError(400, "BAD_ROUTING", "routing must be BRIDGE or CHAINED.");
    }

    const sourceChainId =
      typeof body.sourceChainId === "number" ? body.sourceChainId : Number(body.sourceChainId);
    if (!Number.isFinite(sourceChainId)) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "sourceChainId is required.");
    }

    const upstream = await crossChainFetch("/plan", {
      method: "POST",
      body: { routing, quote: quoteObj },
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const clean = sanitizeUpstreamError(data, detail || "Could not build a cross-chain plan.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const planId = typeof data.planId === "string" ? data.planId : "";
    if (!planId) {
      throw new TradeApiError(502, "BAD_PLAN", "Plan response missing planId.");
    }

    assertPlanStepsSane(data.steps, sourceChainId);

    return publicJson(data);
  } catch (err) {
    return publicError(err, "Unexpected error building cross-chain plan.");
  }
}

/** Poll plan status. ?planId=...&forceRefresh=true */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-plan-poll", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }

    const url = new URL(req.url);
    const planId = url.searchParams.get("planId")?.trim() || "";
    const sourceChainIdRaw = url.searchParams.get("sourceChainId");
    const sourceChainId = sourceChainIdRaw ? Number(sourceChainIdRaw) : NaN;
    const forceRefresh = url.searchParams.get("forceRefresh") === "true";

    if (!planId || !/^[a-zA-Z0-9_-]{1,128}$/.test(planId)) {
      throw new TradeApiError(400, "BAD_PLAN_ID", "planId is required.");
    }

    const query: Record<string, string> = {};
    if (forceRefresh) query.forceRefresh = "true";

    const upstream = await crossChainFetch(`/plan/${encodeURIComponent(planId)}`, {
      method: "GET",
      query,
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const detail = typeof data.detail === "string" ? data.detail : "";
      const clean = sanitizeUpstreamError(data, detail || "Could not fetch plan status.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    if (Number.isFinite(sourceChainId)) {
      assertPlanStepsSane(data.steps, sourceChainId);
    }

    return publicJson(data);
  } catch (err) {
    return publicError(err, "Unexpected error fetching cross-chain plan status.");
  }
}
