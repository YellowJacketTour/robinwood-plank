import { getFollowedActivityFeed } from "@/lib/social-follows";
import { TradeApiError } from "@/lib/uniswap-server";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `?wallet=0x...&limit=50` — newest-first activity from everything that
 * wallet follows (lib/social-follows.ts's getFollowedActivityFeed, a pure
 * read over the existing plank_checks_events ledger). */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "social-feed", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const url = new URL(req.url);
    const wallet = (url.searchParams.get("wallet") || "").trim();
    if (!HEX_ADDRESS.test(wallet)) {
      throw new TradeApiError(400, "BAD_WALLET", "Valid wallet address required.");
    }
    const limitParam = Number(url.searchParams.get("limit") || "50");
    const limit = Number.isFinite(limitParam) ? limitParam : 50;

    const items = await getFollowedActivityFeed(wallet, { limit });
    return publicJson({ ok: true, items });
  } catch (err) {
    return publicError(err, "Failed to load activity feed.");
  }
}
