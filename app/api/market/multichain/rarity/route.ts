/**
 * Reads pre-computed rarity from plank_foreign_rarity (see
 * scripts/index-foreign-rarity.ts and migration 014_foreign_rarity.sql).
 * Returns an empty map, not an error, when a collection hasn't been
 * indexed yet -- that's a real, expected state (indexing is a manual/cron
 * background job, not automatic on first view), and the UI falls back to
 * un-tiered cards rather than showing a fabricated rank.
 */
import { NextRequest, NextResponse } from "next/server";
import { hasForeignRarityStore, getForeignRarity, getForeignTraitIndex } from "@/lib/market/multichain/foreign-rarity-store";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const inFlight = new Set<string>();

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-rarity", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  if (!hasForeignRarityStore()) {
    return NextResponse.json({ byTokenId: {}, indexed: false }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const map = await getForeignRarity(chainSlug, collectionSlug);
    const byTokenId: Record<string, { name: string; tier: string; rank: number; percentile: number; score: number }> = {};
    for (const [tokenId, v] of map) byTokenId[tokenId] = v;
    if (map.size === 0) {
      const job = `${chainSlug}:${collectionSlug.toLowerCase()}`;
      if (!inFlight.has(job)) {
        inFlight.add(job);
        const { indexRarityForCollectionLookup } = await import("@/lib/market/multichain/rarity-index-runner");
        void indexRarityForCollectionLookup(chainSlug, collectionSlug)
          .catch(() => {})
          .finally(() => inFlight.delete(job));
      }
    }
    const meta = await getForeignTraitIndex(chainSlug, collectionSlug).catch(() => null);
    return NextResponse.json(
      {
        byTokenId,
        indexed: map.size > 0,
        sampleSize: meta?.sampleSize ?? map.size,
        partial: map.size > 0 ? map.size < 10_000 : true,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ byTokenId: {}, indexed: false }, { headers: { "Cache-Control": "no-store" } });
  }
}
