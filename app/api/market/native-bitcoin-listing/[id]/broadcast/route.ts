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
import { bitcoinNetwork } from "@/lib/market/multichain/trading/native-bitcoin-listing";
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
    try {
      psbt.finalizeAllInputs();
      finalizedHex = psbt.extractTransaction().toHex();
    } catch (e) {
      return NextResponse.json(
        { error: "INCOMPLETE_SIGNATURES", message: `Could not finalize -- one or more inputs is unsigned or invalid: ${e instanceof Error ? e.message : String(e)}` },
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
