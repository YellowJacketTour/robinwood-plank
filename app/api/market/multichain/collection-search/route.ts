import { NextRequest, NextResponse } from "next/server";
import { searchTrackedCollectionsByName } from "@/lib/market/multichain/store";
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
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-collection-search", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim().slice(0, 96);
  if (query.length < 2) return NextResponse.json({ collections: [] });
  const chainSlugs = (searchParams.get("chains") ?? "").split(",").filter(Boolean);
  try {
    const collections = await searchTrackedCollectionsByName(query, { limit: 60, chainSlugs });
    return NextResponse.json(
      { collections },
      { headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" } }
    );
  } catch (error) {
    return publicError(error, "Failed to search tracked collections");
  }
}
