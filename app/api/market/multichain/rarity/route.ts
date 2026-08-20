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
    const meta = await getForeignTraitIndex(chainSlug, collectionSlug).catch(() => null);
    const sampleSize = meta?.sampleSize ?? map.size;
    // Old first-pass caps (1k/2k/5k) left Claynosaurz stuck at 5,000 forever
    // because we only enqueued when the map was empty. Resume those samples.
    const staleFirstPass = sampleSize === 1_000 || sampleSize === 2_000 || sampleSize === 5_000;
    const needsIndex = map.size === 0 || (staleFirstPass && chainSlug !== "bitcoin-mainnet");
    if (needsIndex) {
      const job = `${chainSlug}:${collectionSlug.toLowerCase()}`;
      if (!inFlight.has(job)) {
        inFlight.add(job);
        const { indexRarityForCollectionLookup } = await import("@/lib/market/multichain/rarity-index-runner");
        void indexRarityForCollectionLookup(chainSlug, collectionSlug)
          .catch(() => {})
          .finally(() => inFlight.delete(job));
      }
    }
    return NextResponse.json(
      {
        byTokenId,
        indexed: map.size > 0,
        sampleSize,
        partial: map.size === 0 || staleFirstPass || chainSlug === "bitcoin-mainnet",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ byTokenId: {}, indexed: false }, { headers: { "Cache-Control": "no-store" } });
  }
}
