/**
 * Builds the unsigned cancel-proof PSBT for a seller to sign in their own
 * wallet -- step 1 of 2 for cancelling a Marketplank-native Bitcoin
 * listing (step 2 is POST .../cancel, which verifies the signed result and
 * actually revokes the listing). See buildCancelProofPsbt's own header in
 * native-bitcoin-listing.ts for why this reuses the app's already-proven
 * signing primitive instead of a new message-signing scheme.
 */
import { NextResponse } from "next/server";
import * as bitcoin from "bitcoinjs-lib";
import { getNativeBitcoinListingById } from "@/lib/market/bitcoin-listings-store";
import { buildCancelProofPsbt, bitcoinNetwork } from "@/lib/market/multichain/trading/native-bitcoin-listing";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = { sellerInternalPubkeyHex?: string };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req, { key: "market-native-bitcoin-listing-cancel-build", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (!body?.sellerInternalPubkeyHex) {
    return NextResponse.json({ error: "sellerInternalPubkeyHex is required" }, { status: 400 });
  }

  try {
    const listing = await getNativeBitcoinListingById(id);
    if (!listing) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Listing not found." }, { status: 404 });
    }
    if (listing.status !== "active") {
      return NextResponse.json({ error: "NOT_ACTIVE", message: `Listing is ${listing.status}, not active.` }, { status: 409 });
    }

    // The listing's own UTXO always lives at the listing's own
    // sellerAddress -- its scriptPubKey is fully determined by that
    // address, no separate stored field needed (same derivation
    // bitcoin.address.fromOutputScript already inverts elsewhere in this
    // app's Bitcoin routes).
    const network = bitcoinNetwork();
    const scriptPubKeyHex = Buffer.from(bitcoin.address.toOutputScript(listing.sellerAddress, network)).toString("hex");

    const result = buildCancelProofPsbt({
      sellerAddress: listing.sellerAddress,
      sellerInternalPubkeyHex: body.sellerInternalPubkeyHex,
      listingUtxo: {
        txid: listing.utxoTxid,
        vout: listing.utxoVout,
        valueSats: listing.utxoValueSats,
        scriptPubKeyHex,
      },
    });

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build the cancel-proof PSBT");
  }
}
