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
import { isSolanaChainSlug, isBitcoinChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { resolveEvmContractAddress } from "@/lib/market/multichain/resolve-contract-address";

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
    // A SHAPE TEST IS NOT AN IDENTITY TEST.
    //
    // This used to require collectionSlug to be 0x-shaped, intending to keep
    // Bitcoin's ordinal ids (never 0x-shaped) out of scope. It also caught
    // every EVM collection addressed by its NAME, which is how the app
    // actually links to them. Measured live on Milady Maker:
    //
    //   ?collectionSlug=milady   -> {"resolved": false}
    //   ?collectionSlug=0x5af0…  -> full metadata, image and traits
    //
    // Same token, same route, same archive. Nothing was missing upstream --
    // the route refused to look. And because the refusal is deterministic,
    // waiting and refreshing could never fix it, which is exactly what "it
    // isn't hydrating anything no matter how long I visit" looks like from
    // the outside.
    //
    // Bitcoin is still excluded, but by CHAIN (what it is) rather than by the
    // shape of a string (what it looks like).
    if (isBitcoinChainSlug(chainSlug)) {
      return NextResponse.json({ resolved: false });
    }
    const contractAddress = await resolveEvmContractAddress(chainSlug, collectionSlug);
    if (!contractAddress) {
      // A real "the archive does not know this collection", which is
      // different from "we declined to try".
      return NextResponse.json({ resolved: false, reason: "collection-unknown" });
    }
    const result = await hydrateSpecificToken(chainSlug, contractAddress, tokenId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Could not hydrate this token right now.");
  }
}
