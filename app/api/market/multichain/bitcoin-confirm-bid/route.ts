/**
 * Server-side proxy for UniSat's confirm_bid step -- submits the
 * wallet-signed PSBT and returns the real, broadcast Bitcoin txid. See
 * bitcoin-buy-psbt/route.ts's header for why this stays server-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { confirmUniSatBid } from "@/lib/market/multichain/adapters/unisat-ordinals-trade";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-bitcoin-confirm", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as
    | { auctionId?: string; bidId?: string; signedPsbtBase64?: string }
    | null;
  if (!body?.auctionId || !body.bidId || !body.signedPsbtBase64) {
    return NextResponse.json({ error: "auctionId, bidId, and signedPsbtBase64 are required" }, { status: 400 });
  }

  try {
    const result = await confirmUniSatBid({
      auctionId: body.auctionId,
      bidId: body.bidId,
      signedPsbtBase64: body.signedPsbtBase64,
    });
    return NextResponse.json({ txid: result.txid }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to confirm the UniSat bid");
  }
}
