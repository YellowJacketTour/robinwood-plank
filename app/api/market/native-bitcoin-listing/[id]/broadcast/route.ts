/**
 * Finalizes the buyer-signed fulfillment PSBT and broadcasts it -- the
 * last step of a Marketplank-native Bitcoin purchase. See
 * native-bitcoin-listing.ts's own header for the protocol.
 *
 * FINALIZATION HAPPENS HERE, SERVER-SIDE, VIA bitcoinjs-lib -- not a
 * signing step (every signature already exists; the buyer's wallet
 * produced them client-side). Finalizing converts each input's stored
 * signature into its final witness stack, which is pure, deterministic,
 * key-free computation -- no private key ever touches this server, same
 * boundary as everywhere else in this app's trading code.
 *
 * THIS ROUTE VERIFIES THE ACTUAL TRANSACTION CONTENT BEFORE RELAYING IT --
 * REQUIRED, NOT OPTIONAL (audit finding, 2026-08-19)
 * ---------------------------------------------------------------------------
 * A previous version of this route finalized and broadcast whatever PSBT
 * it was handed, checking only that the *listing* was active -- never
 * that the *transaction* actually spends that listing's UTXO or pays the
 * seller/fee at all. Two real exploits followed directly from that gap:
 *
 *   1. Listing griefing: anyone could pass ANY validly-signed transaction
 *      (e.g. a 1-sat self-send) against ANY other seller's listing id.
 *      The unrelated tx would broadcast fine, and markNativeBitcoinListingSold
 *      would flip that stranger's live listing to "sold" with a bogus
 *      txid -- the inscription is still theirs, but the listing is now
 *      permanently unbuyable through this app.
 *   2. Fee stripping: the seller's SIGHASH_SINGLE|ANYONECANPAY signature
 *      commits only to ITS OWN input and to output index 1 (the seller's
 *      payment) -- nothing else in the transaction is signature-protected
 *      by the seller. A buyer can take the PSBT from /fulfill, delete the
 *      Marketplank fee output, keep those sats as extra change, sign
 *      their own inputs over the modified transaction, and it remains
 *      fully valid Bitcoin. Without this check, this route would happily
 *      relay that fee-stripped transaction. (The module header's old
 *      claim that this fee is "non-optional by construction, same
 *      doctrine as the EVM Seaport tip" was wrong -- Seaport's
 *      consideration array IS signed by the counterparty; this protocol's
 *      fee output is not, by the nature of SIGHASH_SINGLE|ANYONECANPAY.
 *      This route-level check is therefore the ONLY enforcement point,
 *      not a defense-in-depth extra.)
 *
 * Fix: after finalizing, decode the actual extracted transaction and
 * assert it (a) spends listing.utxoTxid:listing.utxoVout, (b) pays
 * listing.sellerAddress exactly listing.priceSats, and (c) pays
 * feeRecipientAddress() at least the expected fee -- reject and never
 * broadcast otherwise. Off-platform fulfillment (signing the seller's
 * public PSBT and building a fee-free transaction entirely outside this
 * app) remains structurally possible -- that is a limitation of
 * SIGHASH_SINGLE|ANYONECANPAY itself, not something any server-side check
 * can close -- but nothing broadcast THROUGH this app can skip the fee.
 *
 * BROADCAST GOES THROUGH mempool.space's PUBLIC, KEY-FREE REST API
 * (verified live 2026-08-19: POST /api/tx, no auth, ~10 req/s) rather than
 * UniSat's marketplace API -- this listing type was built specifically
 * because UniSat's flow earns Marketplank nothing, so routing broadcast
 * through them too would be an unnecessary dependency on the same party
 * this feature exists to route around. mempool.space is used ONLY as a
 * dumb relay here (raw hex in, txid out) -- it never sees a private key
 * or signs anything.
 *
 * REGTEST HAS NO PUBLIC BROADCAST ENDPOINT, BY DESIGN. A regtest proof
 * broadcasts via a local bitcoin-cli/RPC call instead (see
 * native-bitcoin-listing.ts's own header for the completed regtest proof)
 * -- this route only serves testnet4 and (once NATIVE_BITCOIN_MAINNET_ENABLED
 * is ever set) mainnet.
 */
import { NextRequest, NextResponse } from "next/server";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import {
  bitcoinNetwork,
  feeRecipientAddress,
  MARKETPLANK_NATIVE_BITCOIN_FEE_BPS,
} from "@/lib/market/multichain/trading/native-bitcoin-listing";
import { getNativeBitcoinListingById, markNativeBitcoinListingSold } from "@/lib/market/bitcoin-listings-store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

bitcoin.initEccLib(ecc);

function broadcastBaseUrl(): string {
  const network = bitcoinNetwork();
  if (network === bitcoin.networks.bitcoin) return "https://mempool.space/api";
  if (network === bitcoin.networks.testnet) return "https://mempool.space/testnet4/api";
  throw new Error(
    "native-bitcoin-listing broadcast: no public broadcast endpoint for regtest -- use a local bitcoin-cli sendrawtransaction call instead (see native-bitcoin-listing.ts's own regtest-proof header)."
  );
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const limited = rateLimit(req, { key: "market-native-bitcoin-listing-broadcast", limit: 15, windowMs: 60_000 });
  if (limited) return limited;

  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { signedFulfillmentPsbtBase64?: string } | null;
  if (!body?.signedFulfillmentPsbtBase64) {
    return NextResponse.json({ error: "signedFulfillmentPsbtBase64 is required" }, { status: 400 });
  }

  try {
    const listing = await getNativeBitcoinListingById(id);
    if (!listing) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Listing not found." }, { status: 404 });
    }
    if (listing.status !== "active") {
      return NextResponse.json({ error: "NOT_ACTIVE", message: `Listing is ${listing.status}, not active.` }, { status: 409 });
    }

    const network = bitcoinNetwork();
    const psbt = bitcoin.Psbt.fromBase64(body.signedFulfillmentPsbtBase64, { network });

    let finalizedHex: string;
    let extracted: bitcoin.Transaction;
    try {
      psbt.finalizeAllInputs();
      extracted = psbt.extractTransaction();
      finalizedHex = extracted.toHex();
    } catch (e) {
      return NextResponse.json(
        { error: "INCOMPLETE_SIGNATURES", message: `Could not finalize -- one or more inputs is unsigned or invalid: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 }
      );
    }

    // Verify the ACTUAL transaction content before relaying it -- see this
    // route's own header on why this is the only real enforcement point,
    // not defense-in-depth. Never trust that a PSBT for listing `id`
    // actually concerns that listing until the extracted transaction says so.
    const spendsListingUtxo = extracted.ins.some(
      (input) =>
        Buffer.from(input.hash).reverse().toString("hex") === listing.utxoTxid && input.index === listing.utxoVout
    );
    if (!spendsListingUtxo) {
      return NextResponse.json(
        { error: "UTXO_MISMATCH", message: "This transaction does not spend this listing's inscription UTXO." },
        { status: 400 }
      );
    }

    const expectedSellerScript = bitcoin.address.toOutputScript(listing.sellerAddress, network);
    const paysSellerExactly = extracted.outs.some(
      (out) => Buffer.from(out.script).equals(expectedSellerScript) && Number(out.value) === listing.priceSats
    );
    if (!paysSellerExactly) {
      return NextResponse.json(
        { error: "SELLER_PAYMENT_MISMATCH", message: "This transaction does not pay the seller the exact listed price." },
        { status: 400 }
      );
    }

    const expectedFeeSats = Math.ceil((listing.priceSats * MARKETPLANK_NATIVE_BITCOIN_FEE_BPS) / 10_000);
    const expectedFeeScript = bitcoin.address.toOutputScript(feeRecipientAddress(), network);
    const paysFee = extracted.outs.some(
      (out) => Buffer.from(out.script).equals(expectedFeeScript) && Number(out.value) >= expectedFeeSats
    );
    if (!paysFee) {
      return NextResponse.json(
        { error: "FEE_STRIPPED", message: "This transaction does not include Marketplank's fee output -- refusing to relay it." },
        { status: 400 }
      );
    }

    const base = broadcastBaseUrl();
    const res = await fetch(`${base}/tx`, { method: "POST", body: finalizedHex });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ error: "BROADCAST_FAILED", message: errText.slice(0, 300) }, { status: 502 });
    }
    const txid = (await res.text()).trim();

    // Fails-open on the DB flip: the real transaction is already broadcast
    // and irreversible at this point, so a DB write failure here must
    // never look like the purchase failed -- the txid is the actual
    // source of truth. Still logged loudly rather than silently swallowed.
    const flipped = await markNativeBitcoinListingSold(id, txid).catch((e) => {
      console.error(`native-bitcoin-listing broadcast: DB flip failed for ${id} after real broadcast ${txid}:`, e);
      return false;
    });
    if (!flipped) {
      console.warn(`native-bitcoin-listing broadcast: listing ${id} was not active in DB when marking sold (txid ${txid}) -- possibly already flipped by a concurrent request.`);
    }

    return NextResponse.json({ txid }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to broadcast the fulfillment transaction");
  }
}
