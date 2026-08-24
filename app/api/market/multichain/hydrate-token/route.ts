/**
 * Real-time, single-token on-demand hydration -- see
 * lib/market/multichain/rarity-index-runner.ts's hydrateSpecificToken for
 * the full rationale ("clicks a particular piece... immediately deliver
 * hydration to everything they're exploring"). EVM only today (the same
 * scope hydrateSpecificToken itself covers); Bitcoin/Solana token images
 * already resolve directly from vendor content URLs in the catalog route
 * with no comparable "still pending" gap.
 */
import { NextRequest, NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { hydrateSpecificToken } from "@/lib/market/multichain/rarity-index-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-hydrate-token", limit: 120, windowMs: 60_000 });
  if (limited) return limited;

  const chainSlug = req.nextUrl.searchParams.get("chainSlug");
  const collectionSlug = req.nextUrl.searchParams.get("collectionSlug");
  const tokenId = req.nextUrl.searchParams.get("tokenId");
  if (!chainSlug || !collectionSlug || !tokenId) {
    return NextResponse.json({ error: "chainSlug, collectionSlug and tokenId are required" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(collectionSlug)) {
    // Non-EVM collectionSlug (Solana mint symbol, Bitcoin collection id) --
    // honestly out of scope for this route rather than a fabricated 200.
    return NextResponse.json({ resolved: false });
  }

  try {
    const result = await hydrateSpecificToken(chainSlug, collectionSlug, tokenId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Could not hydrate this token right now.");
  }
}
