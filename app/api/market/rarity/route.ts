import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Isolate-level payload so concurrent rarity hits don't rebuild the map. */
let payloadCache: { at: number; body: unknown } | null = null;
const PAYLOAD_MS = 120_000;

/**
 * Compact name/tier/rank map for every token. Cache aggressively — traits are
 * immutable after reveal.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-rarity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (payloadCache && Date.now() - payloadCache.at < PAYLOAD_MS) {
    return cachedPublicJson(payloadCache.body, "rarity", {
      headers: { "X-Rarity": "memory" },
    });
  }

  try {
    const snapshot = await getRaritySnapshot();
    const byTokenId: Record<string, { name: string; tier: string; rank: number; percentile: number }> =
      {};
    for (const [tokenId, r] of snapshot.byTokenId) {
      byTokenId[String(tokenId)] = {
        name: r.name,
        tier: r.tier,
        rank: r.rank,
        percentile: r.percentile,
      };
    }
    const body = {
      sampleSize: snapshot.sampleSize,
      scoredCount: snapshot.scoredCount,
      tierCounts: snapshot.tierCounts,
      byTokenId,
      // Rank-1-first token ids (up to 12), already computed by
      // computeRaritySnapshot -- surfaced so a caller can show the single
      // rarest real plank (e.g. GlobalMarketHub's home-chain card) without
      // re-deriving rank from the full byTokenId map itself.
      topRarest: snapshot.topRarest,
    };
    payloadCache = { at: Date.now(), body };
    return cachedPublicJson(body, "rarity", { headers: { "X-Rarity": "fresh" } });
  } catch (error) {
    if (payloadCache?.body) {
      return cachedPublicJson(payloadCache.body, "rarity", {
        headers: { "X-Rarity": "memory-stale" },
      });
    }
    return publicError(error, "Could not compute rarity right now.");
  }
}
