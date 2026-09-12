import { NextRequest, NextResponse } from "next/server";
import { COLLECTION_SEARCH_MAX_PAGE, searchTrackedCollectionsByName } from "@/lib/market/multichain/store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real, full-catalog collection search -- independent of GlobalMarketHub's
 * infinite-scroll `collections` state, which only ever holds whatever rows
 * have scrolled into view. See searchTrackedCollectionsByName's own header
 * for the real bug this fixes (a genuinely tracked collection with real
 * indexed pieces returning "no collections match" purely because it hadn't
 * been scrolled to yet).
 */
/** The response size every existing caller already renders. Kept as the
 * DEFAULT, not as the maximum -- clients that pass no ?limit are unaffected by
 * this change except that they now also learn how much they did not get. */
const DEFAULT_LIMIT = 60;

/**
 * `?limit` / `?offset`, and the ceiling that made them necessary.
 *
 * REMOVED 2026-09-11: this handler passed a literal `limit: 60` and never read
 * `?limit`. searchTrackedCollectionsByName would have accepted up to 200, so
 * even the store's own bound was unreachable -- but the real defect was not the
 * number. There was no offset and no total, so a search for a common substring
 * over the 300,000-row catalog returned 60 rows that were indistinguishable
 * from a complete answer. The 61st match could not be retrieved by any request.
 *
 * The response now always carries `totalCount` (how many collections actually
 * match) and `nextOffset` (null iff this page ended the match set). A bound
 * that reports itself is pacing; a bound that stays quiet is a ceiling.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-collection-search", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().slice(0, 96);
  if (query.length < 2) return NextResponse.json({ collections: [], totalCount: 0, nextOffset: null });
  const chainSlugs = (searchParams.get("chains") ?? "").split(",").filter(Boolean);
  // Junk values fall back rather than 400 -- this is a search box, and the
  // store clamps both into range regardless.
  const requestedLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.trunc(requestedLimit) : DEFAULT_LIMIT;
  const requestedOffset = Number(searchParams.get("offset"));
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.trunc(requestedOffset) : 0;
  try {
    const page = await searchTrackedCollectionsByName(query, { limit, offset, chainSlugs });
    return NextResponse.json(
      {
        collections: page.collections,
        // How many collections match the query in full -- NOT how many are in
        // this response. This is the number that makes a short page honest.
        totalCount: page.totalCount,
        // Where to resume, or null when there is nothing left to resume.
        nextOffset: page.nextOffset,
        // Echoed so a caller can see its ?limit was honoured or clamped,
        // instead of inferring it from a row count a short page makes
        // ambiguous.
        pageSize: Math.min(limit, COLLECTION_SEARCH_MAX_PAGE),
      },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } }
    );
  } catch (error) {
    return publicError(error, "Failed to search tracked collections");
  }
}
