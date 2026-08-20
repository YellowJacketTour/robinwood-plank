/**
 * Server-side proxy for Magic Eden's sell (list) and sell_now (accept best
 * bid) instructions -- keeps MAGICEDEN_API_KEY off the client, same reason
 * every other multichain trade-adapter call in this app goes through a
 * route instead of being called directly (see solana-buy-instruction/
 * route.ts's own header, and foreign-fulfill.ts's "DELIBERATELY CALLS OUR
 * OWN API ROUTES" precedent). Returns the unsigned base64 transaction
 * unmodified for the connected Phantom wallet to sign -- this route never
 * signs or broadcasts anything.
 *
 * TWO MODES, ONE ROUTE: `mode: "list"` creates a new fixed-price listing
 * (buildMagicEdenList); `mode: "sellNow"` accepts the current best bid
 * (buildMagicEdenSellNow) -- same split UniSat's own create_bid vs
 * create_bid_prepare distinction mirrors on the Bitcoin side, kept as one
 * route with a mode switch rather than two near-identical files since both
 * calls take the same three fields and differ only in which Magic Eden
 * endpoint they hit.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildMagicEdenList, buildMagicEdenSellNow } from "@/lib/market/multichain/adapters/magiceden-solana-trade";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-solana-sell", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as {
    mode?: "list" | "sellNow";
    sellerAddress?: string;
    tokenMint?: string;
    priceLamports?: string;
  } | null;
  if (!body?.sellerAddress || !body.tokenMint || !body.priceLamports) {
    return NextResponse.json({ error: "sellerAddress, tokenMint, and priceLamports are required" }, { status: 400 });
  }
  if (body.mode !== "list" && body.mode !== "sellNow") {
    return NextResponse.json({ error: 'mode must be "list" or "sellNow"' }, { status: 400 });
  }

  try {
    const instruction =
      body.mode === "list"
        ? await buildMagicEdenList({ sellerAddress: body.sellerAddress, tokenMint: body.tokenMint, priceLamports: body.priceLamports })
        : await buildMagicEdenSellNow({ sellerAddress: body.sellerAddress, tokenMint: body.tokenMint, priceLamports: body.priceLamports });
    return NextResponse.json({ tx: instruction.tx }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build the Magic Eden sell instruction");
  }
}
