/**
 * Builds the unsigned Marketplank-native Bitcoin listing PSBT for a seller
 * to sign in their own wallet (UniSat/Xverse/Leather's signPsbt). Pure
 * construction, no signing, no storage -- this route exists only because
 * bitcoinNetwork()'s NATIVE_BITCOIN_MAINNET_ENABLED/NATIVE_BITCOIN_NETWORK
 * gates (native-bitcoin-listing.ts) are server env vars a client bundle
 * must never read directly. Storing the SIGNED result is a separate step
 * (POST /api/market/multichain/native-bitcoin-listings) -- this route
 * never writes anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildSellerListingPsbt } from "@/lib/market/multichain/trading/native-bitcoin-listing";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-native-bitcoin-listing-build", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | {
        sellerAddress?: string;
        sellerInternalPubkeyHex?: string;
        inscriptionUtxo?: { txid?: string; vout?: number; valueSats?: number; scriptPubKeyHex?: string };
        priceSats?: number;
      }
    | null;

  const u = body?.inscriptionUtxo;
  if (
    !body?.sellerAddress ||
    !body.sellerInternalPubkeyHex ||
    !u?.txid ||
    typeof u.vout !== "number" ||
    typeof u.valueSats !== "number" ||
    !u.scriptPubKeyHex ||
    !body.priceSats
  ) {
    return NextResponse.json(
      { error: "sellerAddress, sellerInternalPubkeyHex, inscriptionUtxo{txid,vout,valueSats,scriptPubKeyHex}, and priceSats are required" },
      { status: 400 }
    );
  }

  try {
    const result = buildSellerListingPsbt({
      sellerAddress: body.sellerAddress,
      sellerInternalPubkeyHex: body.sellerInternalPubkeyHex,
      inscriptionUtxo: {
        txid: u.txid,
        vout: u.vout,
        valueSats: u.valueSats,
        scriptPubKeyHex: u.scriptPubKeyHex,
      },
      priceSats: body.priceSats,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build the listing PSBT");
  }
}
