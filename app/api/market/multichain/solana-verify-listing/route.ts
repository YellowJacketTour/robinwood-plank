/**
 * Server-side, SINGLE-TOKEN on-chain verification for a Solana (Magic Eden
 * M2) listing -- the "confirm this listing is genuinely live on-chain, not
 * just what Magic Eden's API claims" check for the details modal of ONE
 * item a viewer already opened. Deliberately bounded, matching
 * magiceden-m2-onchain.ts's own scope note: this is a single lookup for a
 * token mint the caller already knows, never a collection-wide scan.
 *
 * Two calls total, both cheap and bounded:
 *   1. GET Magic Eden's own per-token listing endpoint
 *      (/v2/tokens/{mint}/listings) -- keyless, same public-API family
 *      listings/route.ts's collection call already uses, just scoped to one
 *      mint -- to get the seller/auctionHouse/tokenAccount lead needed to
 *      derive the real M2 SellerTradeState PDA (no other source in this app
 *      carries auctionHouse/tokenAccount for a listing today).
 *   2. fetchM2Listing -- derives that PDA and does ONE getAccountInfo call
 *      against Solana itself, decoding the REAL on-chain price/expiry.
 *
 * Returns a verified/mismatch verdict comparing what the API claims to what
 * the chain itself says. Server-side only, same reasoning as every other
 * Solana/Bitcoin route in this app: the RPC endpoint is never called
 * directly from the client bundle.
 */
import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { verifySolanaListingOnChain } from "@/lib/market/multichain/solana-listing-verification";
import { publicError, rateLimit } from "@/lib/security";
import { pickHeliusKey } from "@/lib/market/multichain/discovery/helius-key-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same build-time-constant RPC endpoint solana-transfer.ts/foreign-fulfill.ts
// already use client-side -- see test/market/server-feature-flags.test.ts's
// header on why this stays a plain module constant read at the call site
// (in an app/ route, not lib/) rather than something that test's
// KNOWN_BUILD_FROZEN registry needs to track. Uses the multi-key pool
// (least-loaded, live priority) when >1 real Helius key is configured --
// falls back to the single HELIUS_API_KEY otherwise, zero behavior change.
async function solanaRpcUrl(): Promise<string> {
  const helius = await pickHeliusKey("live");
  if (helius) return `https://mainnet.helius-rpc.com/?api-key=${helius.apiKey}`;
  return (
    process.env.SOLANA_RPC_URL?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
    "https://api.mainnet-beta.solana.com"
  );
}

/**
 * Core, testable logic -- takes an already-constructed Connection and an
 * injectable fetch (so tests can stub Magic Eden's response without a real
 * network call) and returns the verdict. The GET handler below is a thin
 * wrapper that builds the real Connection and calls this.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-solana-verify-listing", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const tokenMint = searchParams.get("tokenMint");
  if (!tokenMint) {
    return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });
  }

  try {
    const seller = searchParams.get("seller") ?? undefined;
    const auctionHouse = searchParams.get("auctionHouse") ?? undefined;
    const tokenAccount = searchParams.get("tokenAccount") ?? undefined;
    const priceLamports = searchParams.get("priceLamports") ?? undefined;
    const lead =
      seller && auctionHouse && tokenAccount ? { seller, auctionHouse, tokenAccount, priceLamports } : undefined;
    const connection = new Connection(await solanaRpcUrl(), "confirmed");
    const result = await verifySolanaListingOnChain({ tokenMint, connection, lead });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to verify this listing on-chain");
  }
}
