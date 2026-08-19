/**
 * Builds the unsigned Bitcoin fulfillment PSBT for a buyer purchasing a
 * Marketplank-native listing -- see native-bitcoin-listing.ts's own header
 * for the full protocol (OpenOrdex-derived, dummy-UTXO sat preservation,
 * Marketplank fee baked in). This route only constructs; the buyer's own
 * wallet signs, and POST .../broadcast finalizes + broadcasts separately.
 *
 * The buyer's own reported payment UTXOs are screened through the real
 * UniSat-backed safety gate (bitcoin-utxo-safety.ts, via the engine's
 * default) before any of them are used -- protects the buyer from
 * accidentally paying with a UTXO that holds an inscription or Rune.
 */
import { NextRequest, NextResponse } from "next/server";
import { getNativeBitcoinListingById } from "@/lib/market/bitcoin-listings-store";
import { buildFulfillmentPsbt, type Utxo } from "@/lib/market/multichain/trading/native-bitcoin-listing";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  buyerAddress?: string;
  buyerInternalPubkeyHex?: string;
  buyerReceivingAddress?: string;
  buyerChangeAddress?: string;
  buyerDummyUtxo?: Utxo;
  buyerPaymentUtxoCandidates?: Utxo[];
  feeRateSatPerVb?: number;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req, { key: "market-native-bitcoin-listing-fulfill", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as PostBody | null;
  if (
    !body?.buyerAddress ||
    !body.buyerInternalPubkeyHex ||
    !body.buyerReceivingAddress ||
    !body.buyerChangeAddress ||
    !body.buyerDummyUtxo ||
    !body.buyerPaymentUtxoCandidates?.length ||
    !body.feeRateSatPerVb
  ) {
    return NextResponse.json(
      {
        error:
          "buyerAddress, buyerInternalPubkeyHex, buyerReceivingAddress, buyerChangeAddress, buyerDummyUtxo, buyerPaymentUtxoCandidates, and feeRateSatPerVb are required",
      },
      { status: 400 }
    );
  }

  try {
    const listing = await getNativeBitcoinListingById(id);
    if (!listing) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Listing not found." }, { status: 404 });
    }
    if (listing.status !== "active") {
      return NextResponse.json({ error: "NOT_ACTIVE", message: `Listing is ${listing.status}, not active.` }, { status: 409 });
    }

    const result = await buildFulfillmentPsbt({
      listingSellerPsbtBase64: listing.sellerPsbtBase64,
      sellerInscriptionUtxoValueSats: listing.utxoValueSats,
      buyerAddress: body.buyerAddress,
      buyerInternalPubkeyHex: body.buyerInternalPubkeyHex,
      buyerReceivingAddress: body.buyerReceivingAddress,
      buyerChangeAddress: body.buyerChangeAddress,
      buyerDummyUtxo: body.buyerDummyUtxo,
      buyerPaymentUtxoCandidates: body.buyerPaymentUtxoCandidates,
      feeRateSatPerVb: body.feeRateSatPerVb,
    });

    return NextResponse.json(
      { listingId: id, ...result },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to build the fulfillment PSBT");
  }
}
