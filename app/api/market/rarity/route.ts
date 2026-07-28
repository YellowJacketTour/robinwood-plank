import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Compact name/tier/rank map for every token — one bulk fetch, cached
 * client-side (see lib/market/rarityClient.ts), so every card/row can show
 * a consistent name and tier color without an N-request fan-out. `name` is
 * the Base trait's value (see lib/rarity.ts's TokenRarity.name doc) — the
 * same rule Gallery already used, now shared everywhere a plank is shown.
 * Full trait breakdown for a single token still comes from
 * /api/market/token, which stays the source for detail-view depth.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-rarity", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const snapshot = await getRaritySnapshot();
    const byTokenId: Record<string, { name: string; tier: string; rank: number; percentile: number }> = {};
    for (const [tokenId, r] of snapshot.byTokenId) {
      byTokenId[String(tokenId)] = { name: r.name, tier: r.tier, rank: r.rank, percentile: r.percentile };
    }
    return publicJson({
      sampleSize: snapshot.sampleSize,
      scoredCount: snapshot.scoredCount,
      tierCounts: snapshot.tierCounts,
      byTokenId,
    });
  } catch (error) {
    return publicError(error, "Could not compute rarity right now.");
  }
}
