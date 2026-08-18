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
import { fetchM2Listing } from "@/lib/market/multichain/adapters/magiceden-m2-onchain";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Same build-time-constant RPC endpoint solana-transfer.ts/foreign-fulfill.ts
// already use client-side -- see test/market/server-feature-flags.test.ts's
// header on why this stays a plain module constant read at the call site
// (in an app/ route, not lib/) rather than something that test's
// KNOWN_BUILD_FROZEN registry needs to track.
const SOLANA_RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

type MeTokenListing = {
  pdaAddress?: string;
  auctionHouse?: string;
  tokenAddress?: string;
  seller?: string;
  tokenMint?: string;
  price?: number;
};

export type SolanaListingVerification =
  | { verified: false; reason: string }
  | {
      verified: true;
      priceMatches: boolean;
      onchain: { pda: string; priceLamports: string; seller: string; tokenMint: string; expiry: number };
      apiPriceLamports: string;
    };

/**
 * Core, testable logic -- takes an already-constructed Connection and an
 * injectable fetch (so tests can stub Magic Eden's response without a real
 * network call) and returns the verdict. The GET handler below is a thin
 * wrapper that builds the real Connection and calls this.
 */
export async function verifySolanaListingOnChain(input: {
  tokenMint: string;
  connection: Connection;
  fetchImpl?: typeof fetch;
}): Promise<SolanaListingVerification> {
  const doFetch = input.fetchImpl ?? fetch;
  const res = await doFetch(`https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(input.tokenMint)}/listings`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    return { verified: false, reason: `Magic Eden ${res.status}` };
  }
  const raw = (await res.json().catch(() => null)) as MeTokenListing[] | null;
  const lead = raw?.[0];
  if (!lead?.seller || !lead.auctionHouse || !lead.tokenAddress || typeof lead.price !== "number") {
    return { verified: false, reason: "No active Magic Eden listing found for this token." };
  }

  const onchain = await fetchM2Listing({
    connection: input.connection,
    seller: lead.seller,
    auctionHouse: lead.auctionHouse,
    tokenAccount: lead.tokenAddress,
    tokenMint: input.tokenMint,
  });

  if (!onchain) {
    return { verified: false, reason: "Magic Eden's API shows this listing, but no matching on-chain account was found." };
  }

  // Same 1 SOL = 1e9 lamports unscale convention every other Solana branch
  // in this app uses (see confirmOffer's own comment in
  // MultichainCollectionView.tsx).
  const apiPriceLamports = BigInt(Math.round(lead.price * 1_000_000_000)).toString();

  return {
    verified: true,
    priceMatches: onchain.priceLamports === apiPriceLamports,
    onchain: {
      pda: onchain.pda,
      priceLamports: onchain.priceLamports,
      seller: onchain.wallet,
      tokenMint: onchain.tokenMint,
      expiry: onchain.expiry,
    },
    apiPriceLamports,
  };
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-solana-verify-listing", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const tokenMint = searchParams.get("tokenMint");
  if (!tokenMint) {
    return NextResponse.json({ error: "tokenMint is required" }, { status: 400 });
  }

  try {
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    const result = await verifySolanaListingOnChain({ tokenMint, connection });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to verify this listing on-chain");
  }
}
