/**
 * Marketplank-native Bitcoin Ordinals listings -- store-and-forward, same
 * non-custodial pattern as every other native order route in this app
 * (compare native-swap-orders/route.ts). POST accepts the seller's ALREADY
 * SIGNED listing PSBT (built via native-bitcoin-listing-build/route.ts,
 * signed by the seller's own wallet) and verifies the actual bytes before
 * storing -- never trusts the client's claimed price/utxo, always re-derives
 * them from the PSBT itself. See 026_native_bitcoin_listings.sql and
 * native-bitcoin-listing.ts's own headers for the protocol this serves.
 */
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import {
  bitcoinNetwork,
  MARKETPLANK_NATIVE_BITCOIN_FEE_BPS,
} from "@/lib/market/multichain/trading/native-bitcoin-listing";
import {
  countActiveNativeBitcoinListingsBySeller,
  getActiveNativeBitcoinListings,
  getNativeBitcoinListingsBySeller,
  putNativeBitcoinListing,
} from "@/lib/market/bitcoin-listings-store";
import { publicError, publicJson, rateLimit, readJsonBody } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

bitcoin.initEccLib(ecc);

const MAX_ACTIVE_LISTINGS_PER_SELLER = 50;

type PostBody = {
  inscriptionId?: unknown;
  sellerPsbtBase64?: unknown;
};

export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-bitcoin-listings-get", limit: 120, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const seller = searchParams.get("seller");
    const limitParam = searchParams.get("limit");
    const limit = limitParam ? Number(limitParam) : undefined;

    const listings = seller
      ? await getNativeBitcoinListingsBySeller(seller)
      : await getActiveNativeBitcoinListings(limit);
    return publicJson({ listings });
  } catch (err) {
    return publicError(err, "Failed to load native Bitcoin listings.");
  }
}

export async function POST(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-multichain-native-bitcoin-listings-post", limit: 15, windowMs: 60_000 });
    if (limited) return limited;

    const body = await readJsonBody<PostBody>(req);
    const inscriptionId = typeof body.inscriptionId === "string" ? body.inscriptionId.trim() : "";
    const sellerPsbtBase64 = typeof body.sellerPsbtBase64 === "string" ? body.sellerPsbtBase64 : "";
    if (!inscriptionId || !sellerPsbtBase64) {
      return publicJson({ error: "BAD_REQUEST", message: "inscriptionId and sellerPsbtBase64 are required." }, 400);
    }

    // Re-derive everything from the actual signed PSBT bytes -- never trust
    // a client-claimed price, seller address, or UTXO. This mirrors
    // extractSellerLeg's own validation inside native-bitcoin-listing.ts
    // (kept separate here because that function is deliberately internal
    // to buildFulfillmentPsbt, not exported for route-level use).
    const network = bitcoinNetwork();
    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(sellerPsbtBase64, { network });
    } catch {
      return publicJson({ error: "BAD_PSBT", message: "Could not parse the listing PSBT." }, 400);
    }
    if (psbt.txInputs.length !== 1 || psbt.txOutputs.length !== 1) {
      return publicJson({ error: "BAD_SHAPE", message: "Listing PSBT must have exactly one input and one output." }, 400);
    }
    const inputData = psbt.data.inputs[0];
    if (!inputData.tapKeySig && !inputData.partialSig) {
      return publicJson({ error: "UNSIGNED", message: "Listing PSBT's input is not signed." }, 400);
    }
    if (!inputData.witnessUtxo) {
      return publicJson({ error: "BAD_SHAPE", message: "Listing PSBT is missing its witness UTXO." }, 400);
    }

    const rawInput = psbt.txInputs[0];
    const utxoTxid = Buffer.from(rawInput.hash).reverse().toString("hex");
    const utxoVout = rawInput.index;
    const utxoValueSats = Number(inputData.witnessUtxo.value);
    // Sanity check: the inscription UTXO's own script must decode as a
    // valid address on this network too -- catches a malformed/foreign-
    // network witnessUtxo before it's ever stored.
    try {
      bitcoin.address.fromOutputScript(inputData.witnessUtxo.script, network);
    } catch {
      return publicJson({ error: "BAD_SHAPE", message: "Listing PSBT's inscription UTXO script is not a valid address on this network." }, 400);
    }

    const outputScript = psbt.txOutputs[0].script;
    let sellerAddress: string;
    try {
      sellerAddress = bitcoin.address.fromOutputScript(outputScript, network);
    } catch {
      return publicJson({ error: "BAD_SHAPE", message: "Could not decode the listing's payment address." }, 400);
    }
    const priceSats = Number(psbt.txOutputs[0].value);
    if (priceSats <= 0) {
      return publicJson({ error: "BAD_PRICE", message: "Listed price must be positive." }, 400);
    }

    if ((await countActiveNativeBitcoinListingsBySeller(sellerAddress)) >= MAX_ACTIVE_LISTINGS_PER_SELLER) {
      return publicJson({ error: "TOO_MANY", message: "You have too many open Bitcoin listings." }, 429);
    }

    const id = `native-btc-${sellerAddress}-${utxoTxid}-${utxoVout}`;
    await putNativeBitcoinListing({
      id,
      sellerAddress,
      inscriptionId,
      utxoTxid,
      utxoVout,
      utxoValueSats,
      priceSats,
      sellerPsbtBase64,
    });

    return publicJson({
      listing: { id, sellerAddress, inscriptionId, utxoTxid, utxoVout, utxoValueSats, priceSats, status: "active" },
      marketplankFeeBps: MARKETPLANK_NATIVE_BITCOIN_FEE_BPS,
    });
  } catch (err) {
    return publicError(err, "Failed to create the native Bitcoin listing.");
  }
}
