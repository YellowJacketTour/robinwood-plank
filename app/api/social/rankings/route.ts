import { rankTargetsByEndorsement } from "@/lib/social-endorsements";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * `?targetType=collection&limit=50` — reputation-weighted leaderboard for
 * collections (or wallets), surfacing lib/social-endorsements.ts's
 * rankTargetsByEndorsement, which re-derives every voter's weight from real
 * Plank Checks points + Bad Boards standing and applies the per-voter
 * dilution factor before scoring (see lib/social-rankings.ts).
 * Defaults to "collection" since that is the primary leaderboard surface;
 * "wallet" rankings are supported for a future reputation-leaderboard-by-
 * wallet surface.
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "social-rankings", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const targetTypeParam = url.searchParams.get("targetType") || "collection";
    if (targetTypeParam !== "collection" && targetTypeParam !== "wallet") {
      throw new TradeApiError(400, "BAD_TARGET_TYPE", "targetType must be 'wallet' or 'collection'.");
    }
    const limitParam = Number(url.searchParams.get("limit") || "50");
    const limit = Number.isFinite(limitParam) ? limitParam : 50;

    const ranked = await rankTargetsByEndorsement(targetTypeParam, { limit });
    return publicJson({ ok: true, targetType: targetTypeParam, ranked });
  } catch (err) {
    return publicError(err, "Failed to load rankings.");
  }
}
