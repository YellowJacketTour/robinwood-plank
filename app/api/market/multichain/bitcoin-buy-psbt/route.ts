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

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-bitcoin-buy", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { address?: string; auctionId?: string; bidPriceSats?: string; pubkey?: string }
    | null;
  if (!body?.address || !body.auctionId || !body.bidPriceSats || !body.pubkey) {
    return NextResponse.json({ error: "address, auctionId, bidPriceSats, and pubkey are required" }, { status: 400 });
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
