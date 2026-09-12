import { NextRequest, NextResponse } from "next/server";
import { hasCollectionTokenStore, searchProjectedTokens, TOKEN_SEARCH_MAX_PAGE, type GlobalTokenSearchHit } from "@/lib/market/multichain/collection-token-store";
import { getTrackedCollection, findCollectionsByCreatorSignals } from "@/lib/market/multichain/store";
import { extractNameByline, findRelatedByCreator, flattenRelatedCreatorGroup, type RelatedCreatorHit } from "@/lib/market/multichain/creator-links";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** What a caller gets when it says nothing about paging. Unchanged from the
 * hardcoded value this route used to pass, so every existing client keeps the
 * response size it already renders -- the difference is that 41 is now
 * reachable, not that 40 stopped being the default. */
const DEFAULT_LIMIT = 40;

/**
 * `?limit` / `?cursor`, and why this route used to have neither.
 *
 * REAL CEILING, REMOVED 2026-09-11: this handler called
 * `searchProjectedTokens({ ..., limit: 40 })` -- a literal -- and never read
 * `?limit` at all. The store clamped to 60, so even that 60 was unreachable
 * through the only route that calls it. There was no offset, no cursor and no
 * count, which made a global search across a 19.4M-row projection return a
 * flat 40 rows with NO WAY to see the 41st. A search that finds 5,000 matches
 * and a search that finds exactly 40 produced byte-identical responses.
 *
 * That is the house rule's failure mode verbatim: a miss was indistinguishable
 * from "nothing happened". The fix is not "raise 40 to a bigger number" -- any
 * fixed number has a 41st row. The fix is that the response now always says
 * whether it is complete (`nextCursor === null`) and, when it is not, exactly
 * where to resume.
 *
 * The per-response page bound survives as PACING: one HTTP response must fit in
 * one HTTP response, and the hub fires this on a 220 ms debounce per keystroke.
 * TOKEN_SEARCH_MAX_PAGE bounds a single page; it bounds nothing about the
 * result set.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-global-token-search", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().slice(0, 96);
  if (query.length < 2) return NextResponse.json({ tokens: [], nextCursor: null });
  if (!hasCollectionTokenStore()) return NextResponse.json({ tokens: [], nextCursor: null });
  const chainSlugs = (searchParams.get("chains") ?? "").split(",").filter(Boolean);
  const rarityTier = searchParams.get("rarityTier");
  const traitType = searchParams.get("traitType");
  const traitValue = searchParams.get("traitValue");
  const trait = traitType && traitValue ? { traitType, value: traitValue } : null;
  // A junk ?limit falls back to the default rather than 400-ing: this is a
  // search box, and the store clamps into range anyway.
  const requested = Number(searchParams.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : DEFAULT_LIMIT;
  const cursor = searchParams.get("cursor");
  try {
    const page = await searchProjectedTokens({ query, chainSlugs, limit, cursor, rarityTier, trait });
    const relatedByCreator = await relatedCreatorHitsForTopMatch(page.tokens);
    return NextResponse.json({
      tokens: page.tokens,
      // Non-null means "there is more, resume here". Null means the search is
      // genuinely exhausted. The client never has to guess which it got.
      nextCursor: page.nextCursor,
      // Echoed so a caller can see that its ?limit was honoured (or clamped)
      // instead of inferring it from a row count that a short final page makes
      // ambiguous.
      pageSize: Math.min(limit, TOKEN_SEARCH_MAX_PAGE),
    }, {
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
  tokens: GlobalTokenSearchHit[]
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
