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
    const { readProjectedTraitIndex } = await import("@/lib/market/multichain/collection-token-store");
    const hasStoredTraits = Boolean(traitIndex && Object.keys(traitIndex).length > 0);
    const projected = hasStoredTraits ? null : await readProjectedTraitIndex(chainSlug, collectionSlug).catch(() => null);
    const effectiveTraits = hasStoredTraits ? traitIndex : (projected && Object.keys(projected.traits).length > 0 ? projected.traits : null);
    const effectivePartial = hasStoredTraits ? partial : projected?.partial ?? true;
    const scanned = hasStoredTraits ? sampleSize : projected?.projectedCount ?? 0;

    // A visit is real demand. Keep provider work out of the request itself,
    // but raise this collection ahead of the background round-robin. The two
    // jobs are deliberately separate: membership discovers every token ID;
    // metadata resolves tokenURI attributes and only then can rarity close.
    if (effectiveTraits === null || effectivePartial) {
      const { prioritizeCollectionDemand } = await import("@/lib/market/multichain/collection-demand");
      void prioritizeCollectionDemand(chainSlug, collectionSlug).catch(() => {});
    }

    return NextResponse.json(
      {
        collection: collectionSlug,
        complete: effectiveTraits !== null && !effectivePartial,
        partial: effectivePartial,
        // Partial traits are a live work-in-progress, not a completed index.
        // The collection view uses this signal to keep refreshing until the
        // durable membership cursor closes and full-population rarity exists.
        building: effectivePartial,
        totalSupply: projected?.expectedCount ?? (sampleSize || null),
        scanned,
        traits: effectiveTraits,
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
