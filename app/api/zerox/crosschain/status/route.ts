import {
  assertCrossChainSourceAllowed,
  isZeroXConfigured,
  mapCrossChainLifecycle,
  sanitizeZeroXError,
  TradeApiError,
  ZEROX_CROSSCHAIN_ENABLED,
  zeroxCrossChainStatusFetch,
} from "@/lib/zerox-server";
import type { ZeroXCrossChainStatusResponse } from "@/lib/zerox-types";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Poll settlement of a one-step cross-chain buy after the user has sent the
 * origin-chain transaction. Cross-chain settlement is NON-ATOMIC (0x's own
 * documented risk, not hypothetical): the origin tx can confirm while the
 * bridge/destination leg fails, and any refund is NOT guaranteed to land
 * back as the original sellToken or on the original chain — this endpoint
 * exists so the UI can show the user real settlement state instead of
 * silently assuming success once the origin tx confirms.
 *
 * GET, not POST: this is a read-only lookup keyed on a public tx hash, no
 * fee/pair decision to protect — but still allowlist-gated (originChain
 * must be one of our reviewed source chains) and still fails closed with
 * NO_API_KEY when unconfigured, same as every other route in this module.
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "zerox-xchain-status", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    if (!ZEROX_CROSSCHAIN_ENABLED) {
      throw new TradeApiError(404, "ZEROX_CROSSCHAIN_DISABLED", "0x cross-chain buys are not enabled.");
    }
    if (!isZeroXConfigured()) {
      throw new TradeApiError(503, "NO_API_KEY", "0x API key is not configured on the server.");
    }

    const url = new URL(req.url);
    const originChainRaw = url.searchParams.get("originChain");
    const originTxHash = url.searchParams.get("originTxHash")?.trim() || "";
    const quoteId = url.searchParams.get("quoteId")?.trim() || undefined;

    const originChain = Number(originChainRaw);
    if (!Number.isFinite(originChain)) {
      throw new TradeApiError(400, "BAD_SOURCE_CHAIN", "originChain must be a number.");
    }
    assertCrossChainSourceAllowed(originChain);

    if (!originTxHash || !/^0x[a-fA-F0-9]{64,66}$/.test(originTxHash)) {
      throw new TradeApiError(400, "BAD_TX_HASH", "originTxHash must be a valid transaction hash.");
    }

    const upstream = await zeroxCrossChainStatusFetch({ originChain, originTxHash, quoteId });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;

    if (!upstream.ok) {
      const name = typeof data.name === "string" ? data.name : "";
      if (name === "TRANSACTION_NOT_FOUND") {
        return publicJson({ lifecycle: "origin_tx_pending" } satisfies ZeroXCrossChainStatusResponse);
      }
      const clean = sanitizeZeroXError(data, "0x cross-chain status lookup failed.");
      return publicJson(clean, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502);
    }

    const responseBody: ZeroXCrossChainStatusResponse = {
      lifecycle: mapCrossChainLifecycle(data),
      raw: data,
    };
    return publicJson(responseBody);
  } catch (err) {
    return publicError(err, "Unexpected error checking 0x cross-chain status.");
  }
}
