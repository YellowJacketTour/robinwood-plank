import { TradeApiError } from "@/lib/uniswap-server";
import { CROSSCHAIN_ENABLED } from "@/lib/crosschain-constants";
import { crossChainFetch } from "@/lib/crosschain-server";
import { publicError, publicJson, rateLimit, readJsonBody, sanitizeUpstreamError } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  planId?: unknown;
  stepIndex?: unknown;
  txHash?: unknown;
  chainId?: unknown;
};

/**
 * Submit proof (a tx hash) for one plan step, once the client's own wallet
 * has broadcast it. We never build or sign anything here — the client signs
 * locally and only reports the resulting hash, which Uniswap's /plan state
 * machine validates against its own expected on-chain state before
 * advancing. This is the lowest-risk kind of passthrough: the only thing we
 * relay is a hash the wallet already produced.
 *
 * NOTE: the exact PATCH /plan schema for step-proof submission is not fully
 * documented publicly as of 2026-07-30 (see chained-actions-integration
 * guide) — this shape is a best-effort match and should be confirmed
 * against a live plan before this feature ships enabled.
 */
export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "crosschain-plan-submit", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    if (!CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "NOT_ENABLED", "Cross-chain buys are not enabled.");
    }

    const body = await readJsonBody<Body>(req);
    const planId = typeof body.planId === "string" ? body.planId.trim() : "";
    if (!planId || !/^[a-zA-Z0-9_-]{1,128}$/.test(planId)) {
      throw new TradeApiError(400, "BAD_PLAN_ID", "planId is required.");
    }
    const stepIndex =
      typeof body.stepIndex === "number" ? body.stepIndex : Number(body.stepIndex);
    if (!Number.isFinite(stepIndex) || stepIndex < 0) {
      throw new TradeApiError(400, "BAD_STEP_INDEX", "stepIndex is required.");
    }
    const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
    if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      throw new TradeApiError(400, "BAD_TX_HASH", "txHash must be a valid transaction hash.");
    }
    const chainId = typeof body.chainId === "number" ? body.chainId : Number(body.chainId);
    if (!Number.isFinite(chainId)) {
      throw new TradeApiError(400, "BAD_CHAIN", "chainId is required.");
    }

    const upstream = await crossChainFetch(`/plan/${encodeURIComponent(planId)}`, {
      method: "PATCH",
      body: { stepIndex, txHash, chainId },
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      // Per the chained-actions guide: a rejected proof leaves the step
      // AWAITING_ACTION for retry rather than moving to STEP_ERROR — surface
      // that distinction so the client knows this is retryable.
      const detail = typeof data.detail === "string" ? data.detail : "";
      const clean = sanitizeUpstreamError(data, detail || "Could not submit step proof — retryable.");
      return publicJson(
        { ...clean, retryable: true },
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502
      );
    }

    return publicJson(data);
  } catch (err) {
    return publicError(err, "Unexpected error submitting cross-chain step.");
  }
}

export function GET() {
  return publicJson({ error: "METHOD", message: "Use POST." }, 405);
}
