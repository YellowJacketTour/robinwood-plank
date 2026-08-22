/**
 * Foreign-chain counterpart to GET /api/market/traits (native's own trait
 * index) -- same TraitIndexResponse shape, read from
 * plank_foreign_rarity_collections.trait_index (written by
 * scripts/index-foreign-rarity.ts's same pagination pass that builds
 * rarity). Exists so ForeignOfferForm can call the SAME pure
 * resolveCriteriaTokenIds (lib/market/trait-criteria.ts) native's OfferForm
 * uses, unmodified -- that function only needs a real TraitMap, it has no
 * chain dependency at all.
 */
import { NextRequest, NextResponse } from "next/server";
import { hasForeignRarityStore, getForeignTraitIndex, getForeignRarity } from "@/lib/market/multichain/foreign-rarity-store";
import { rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-trait-index", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }

  if (!hasForeignRarityStore()) {
    return NextResponse.json(
      { collection: collectionSlug, complete: false, building: false, totalSupply: null, scanned: 0, traits: null, rankings: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const [{ traitIndex, sampleSize, partial }, rarityMap] = await Promise.all([
      getForeignTraitIndex(chainSlug, collectionSlug),
      getForeignRarity(chainSlug, collectionSlug),
    ]);
    const rankings: Record<string, number> = {};
    for (const [tokenId, r] of rarityMap) rankings[tokenId] = r.rank;

    return NextResponse.json(
      {
        collection: collectionSlug,
        complete: traitIndex !== null && !partial,
        partial,
        building: false,
        totalSupply: sampleSize || null,
        scanned: sampleSize,
        traits: traitIndex,
        rankings: Object.keys(rankings).length > 0 ? rankings : null,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { collection: collectionSlug, complete: false, building: false, totalSupply: null, scanned: 0, traits: null, rankings: null },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}
