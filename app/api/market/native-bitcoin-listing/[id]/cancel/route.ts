/**
 * Step 2 of 2 for cancelling a Marketplank-native Bitcoin listing (step 1
 * is POST .../cancel-build). Verifies the seller's signed cancel-proof
 * PSBT actually proves current control of the listing's own UTXO, then
 * revokes the listing -- closes audit finding H2 (2026-08-20):
 * cancelNativeBitcoinListing already existed but had zero authenticated
 * callers, so a seller had no way to withdraw a stale/unwanted listing.
 */
import { NextResponse } from "next/server";
import { getNativeBitcoinListingById, cancelNativeBitcoinListing } from "@/lib/market/bitcoin-listings-store";
import { verifyCancelProofPsbt } from "@/lib/market/multichain/trading/native-bitcoin-listing";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = { signedCancelProofPsbtBase64?: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req, { key: "market-native-bitcoin-listing-cancel", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body?.signedCancelProofPsbtBase64) {
    return NextResponse.json({ error: "signedCancelProofPsbtBase64 is required" }, { status: 400 });
  }

  try {
    const listing = await getNativeBitcoinListingById(id);
    if (!listing) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Listing not found." }, { status: 404 });
    }
    if (listing.status !== "active") {
      return NextResponse.json({ error: "NOT_ACTIVE", message: `Listing is ${listing.status}, not active.` }, { status: 409 });
    }

    const verified = verifyCancelProofPsbt(
      body.signedCancelProofPsbtBase64,
      { txid: listing.utxoTxid, vout: listing.utxoVout },
      listing.sellerAddress
    );
    if (!verified) {
      return NextResponse.json(
        { error: "BAD_PROOF", message: "Could not verify this cancel request proves control of the listed inscription." },
        { status: 403 }
      );
    }

    const cancelled = await cancelNativeBitcoinListing(id, listing.sellerAddress);
    if (!cancelled) {
      // Real race: the listing was fulfilled or already cancelled between
      // the status check above and this call. Report honestly rather than
      // claiming success for something that didn't happen.
      return NextResponse.json({ error: "ALREADY_INACTIVE", message: "This listing is no longer active." }, { status: 409 });
    }

    return NextResponse.json({ listingId: id, status: "cancelled" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to cancel the listing");
  }
}
