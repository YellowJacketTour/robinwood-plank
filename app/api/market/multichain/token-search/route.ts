import { NextRequest, NextResponse } from "next/server";
import { hasCollectionTokenStore, searchProjectedTokens } from "@/lib/market/multichain/collection-token-store";
import { getTrackedCollection, findCollectionsByCreatorSignals } from "@/lib/market/multichain/store";
import { extractNameByline, findRelatedByCreator, flattenRelatedCreatorGroup, type RelatedCreatorHit } from "@/lib/market/multichain/creator-links";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-global-token-search", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().slice(0, 96);
  if (query.length < 2) return NextResponse.json({ tokens: [] });
  if (!hasCollectionTokenStore()) return NextResponse.json({ tokens: [] });
  const chainSlugs = (searchParams.get("chains") ?? "").split(",").filter(Boolean);
  const rarityTier = searchParams.get("rarityTier");
  const traitType = searchParams.get("traitType");
  const traitValue = searchParams.get("traitValue");
  const trait = traitType && traitValue ? { traitType, value: traitValue } : null;
  try {
    const tokens = await searchProjectedTokens({ query, chainSlugs, limit: 40, rarityTier, trait });
    const relatedByCreator = await relatedCreatorHitsForTopMatch(tokens);
    return NextResponse.json({ tokens, relatedByCreator }, {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    return publicError(error, "Failed to search indexed pieces");
  }
}

/**
 * Creator-aware search expansion: when the top token match belongs to a
 * tracked collection with a real creator identity signal, surface that
 * creator's OTHER tracked collections too (e.g. searching "mugs" also
 * surfaces 9mm.Pro's Based OG and Genesis OG). Only looks at the single
 * best match -- cheap, and a token search result page is already ordered by
 * relevance so the top hit is the right anchor. See creator-links.ts for
 * the corroborated-vs-address-only confidence split this relies on.
 */
async function relatedCreatorHitsForTopMatch(
  tokens: Awaited<ReturnType<typeof searchProjectedTokens>>
): Promise<RelatedCreatorHit[]> {
  const top = tokens[0];
  if (!top) return [];
  const target = await getTrackedCollection(top.chainSlug, top.collectionSlug);
  if (!target) return [];
  const nameByline = extractNameByline(target.name);
  if (!target.creatorAddress && !target.creatorHandle && !target.creatorEns && !nameByline) return [];
  const candidates = await findCollectionsByCreatorSignals({
    creatorAddress: target.creatorAddress,
    creatorHandle: target.creatorHandle,
    creatorEns: target.creatorEns,
    nameByline,
    excludeChainSlug: target.chainSlug,
    excludeContractAddress: target.contractAddress,
  });
  const group = findRelatedByCreator(
    [{ chainSlug: target.chainSlug, contractAddress: target.contractAddress, name: target.name, creatorAddress: target.creatorAddress, creatorHandle: target.creatorHandle, creatorEns: target.creatorEns }, ...candidates],
    { chainSlug: target.chainSlug, contractAddress: target.contractAddress, name: target.name, creatorAddress: target.creatorAddress, creatorHandle: target.creatorHandle, creatorEns: target.creatorEns }
  );
  return flattenRelatedCreatorGroup(group);
}
