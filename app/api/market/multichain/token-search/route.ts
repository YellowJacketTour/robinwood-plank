import { NextRequest, NextResponse } from "next/server";
import { hasCollectionTokenStore, searchProjectedTokens } from "@/lib/market/multichain/collection-token-store";
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
    return NextResponse.json({ tokens }, {
      headers: { "Cache-Control": "public, s-maxage=10, stale-while-revalidate=30" },
    });
  } catch (error) {
    return publicError(error, "Failed to search indexed pieces");
  }
}
