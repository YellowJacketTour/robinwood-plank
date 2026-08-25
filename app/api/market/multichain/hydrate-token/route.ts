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
import { hydrateSpecificSolanaToken } from "@/lib/market/multichain/discovery/solana-token-hydrate";
import { isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

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

  try {
    // REAL GAP FIXED 2026-08-24 ("hydration on demand isnt working on sol
    // collections"): this route used to be hard-EVM-only (a raw
    // `/^0x.../` check on collectionSlug), so a Solana token's mint
    // address (never 0x-shaped) always short-circuited to a fabricated-
    // looking `{resolved:false}` with zero real attempt made. Solana gets
    // its own real resolver -- see solana-token-hydrate.ts's own header
    // for the DAS-first, free-on-chain-fallback discipline it shares with
    // this session's other Solana fixes. Bitcoin stays genuinely out of
    // scope for now (its catalog images already resolve directly from
    // real vendor content URLs with no comparable "still pending" state
    // the way EVM/Solana token metadata can be).
    if (isSolanaChainSlug(chainSlug)) {
      const result = await hydrateSpecificSolanaToken(chainSlug, collectionSlug, tokenId);
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(collectionSlug)) {
      // Bitcoin collectionSlug (an ordinal collection id, never 0x-shaped)
      // -- honestly out of scope for this route rather than a fabricated 200.
      return NextResponse.json({ resolved: false });
    }
    const result = await hydrateSpecificToken(chainSlug, collectionSlug, tokenId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Could not hydrate this token right now.");
  }
}
