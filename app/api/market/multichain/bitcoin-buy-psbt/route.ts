/**
 * Server-side proxy for UniSat's create_bid step -- keeps UNISAT_API_KEY off
 * the client, same reason as solana-buy-instruction/route.ts. Returns the
 * unsigned PSBT (base64) plus which input indexes the buyer's wallet must
 * sign, passed through exactly as UniSat's API returns it (never
 * recomputed here -- see unisat-ordinals-trade.ts's own header on why
 * independently selecting/signing the wrong indexes is a real fund-safety
 * risk for an Ordinals UTXO).
 */
import { NextRequest, NextResponse } from "next/server";
import { createUniSatBid } from "@/lib/market/multichain/adapters/unisat-ordinals-trade";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Real, tighter than the default -- this proxies a metered UNISAT_API_KEY
// with a documented 1,000-call/day free-tier ceiling (see
// unisat-ordinals-trade.ts's own requireApiKey), so an open-ended limit
// here is a shared-resource risk, not just a per-caller one (audit
// finding, 2026-08-19).
const RATE_LIMIT = { key: "market-multichain-bitcoin-buy", limit: 10, windowMs: 60_000 };

/** 33-byte compressed secp256k1 pubkey, hex-encoded -- the real shape UniSat's own API requires (see createUniSatBid's own header). Rejects obviously-wrong input before it ever reaches a metered UniSat call. */
const COMPRESSED_PUBKEY_HEX = /^0[23][0-9a-fA-F]{64}$/;

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, RATE_LIMIT);
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { address?: string; auctionId?: string; bidPriceSats?: string; pubkey?: string }
    | null;
  if (!body?.address || !body.auctionId || !body.bidPriceSats || !body.pubkey) {
    return NextResponse.json({ error: "address, auctionId, bidPriceSats, and pubkey are required" }, { status: 400 });
  }
  // Real validation, not just presence (audit finding, 2026-08-19) -- a
  // malformed bidPriceSats/pubkey used to reach UniSat's metered API
  // (and, per createUniSatBid, Number("abc") serializes to `null` in the
  // outbound request rather than being rejected here) before failing
  // there instead of here, burning a call from the shared free-tier quota
  // for input that was never going to succeed.
  const priceSats = Number(body.bidPriceSats);
  if (!Number.isInteger(priceSats) || priceSats <= 0 || priceSats > 21_000_000 * 100_000_000) {
    return NextResponse.json({ error: "bidPriceSats must be a positive integer number of satoshis" }, { status: 400 });
  }
  if (!COMPRESSED_PUBKEY_HEX.test(body.pubkey)) {
    return NextResponse.json({ error: "pubkey must be a 33-byte compressed secp256k1 public key, hex-encoded" }, { status: 400 });
  }

  try {
    const step = await createUniSatBid({
      address: body.address,
      auctionId: body.auctionId,
      bidPriceSats: body.bidPriceSats,
      pubkey: body.pubkey,
    });
    return NextResponse.json(
      { psbtBase64: step.psbtBase64, signIndexes: step.signIndexes, auctionId: step.auctionId, bidId: step.bidId },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to build the UniSat bid PSBT");
  }
}
