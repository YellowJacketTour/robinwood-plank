/**
 * Server-side proxy for Magic Eden's BID (offer) instruction --
 * /instructions/buy, the "Make offer" counterpart to
 * solana-buy-instruction's buy_now proxy. Same MAGICEDEN_API_KEY-off-the-
 * client reasoning as that route's own header. Returns the unsigned base64
 * transaction unmodified for the connected Phantom wallet to sign -- this
 * route never signs or broadcasts anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildMagicEdenBid } from "@/lib/market/multichain/adapters/magiceden-solana-trade";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-solana-bid", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { buyerAddress?: string; tokenMint?: string; priceLamports?: string } | null;
  if (!body?.buyerAddress || !body.tokenMint || !body.priceLamports) {
    return NextResponse.json({ error: "buyerAddress, tokenMint, and priceLamports are required" }, { status: 400 });
  }

  try {
    const instruction = await buildMagicEdenBid({
      buyerAddress: body.buyerAddress,
      tokenMint: body.tokenMint,
      priceLamports: body.priceLamports,
    });
    return NextResponse.json({ tx: instruction.tx }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build the Magic Eden bid instruction");
  }
}
