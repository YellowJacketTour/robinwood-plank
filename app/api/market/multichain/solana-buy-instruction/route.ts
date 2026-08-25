/**
 * Server-side proxy for Magic Eden's buy_now instruction -- keeps
 * MAGICEDEN_API_KEY off the client, same reason every other multichain
 * trade-adapter call in this app goes through a route instead of being
 * called directly from foreign-fulfill.ts (see that file's own header on
 * "DELIBERATELY CALLS OUR OWN API ROUTES, NEVER foreign-orders.ts DIRECTLY").
 * Returns the unsigned base64 transaction unmodified for the connected
 * Phantom wallet to sign -- this route never signs or broadcasts anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { Connection } from "@solana/web3.js";
import { buildMagicEdenBuyNow } from "@/lib/market/multichain/adapters/magiceden-solana-trade";
import { fetchM2Listing } from "@/lib/market/multichain/adapters/magiceden-m2-onchain";
import { publicError, rateLimit } from "@/lib/security";
import { looksLikeSolanaPubkey } from "@/lib/market/multichain/solana-pubkey";
import { pickHeliusKey } from "@/lib/market/multichain/discovery/helius-key-pool";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-solana-buy", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as {
    buyerAddress?: string;
    tokenMint?: string;
    priceLamports?: string;
    seller?: string;
    auctionHouse?: string;
    tokenAccount?: string;
  } | null;
  if (!body?.buyerAddress || !body.tokenMint || !body.priceLamports) {
    return NextResponse.json({ error: "buyerAddress, tokenMint, and priceLamports are required" }, { status: 400 });
  }

  try {
    if (body.seller && body.auctionHouse && body.tokenAccount && looksLikeSolanaPubkey(body.tokenMint)) {
      const helius = await pickHeliusKey("live");
      const rpc = helius
        ? `https://mainnet.helius-rpc.com/?api-key=${helius.apiKey}`
        : process.env.SOLANA_RPC_URL?.trim() ||
          process.env.NEXT_PUBLIC_SOLANA_RPC_URL?.trim() ||
          "https://api.mainnet-beta.solana.com";
      const onchain = await fetchM2Listing({
        connection: new Connection(rpc, "confirmed"),
        seller: body.seller,
        auctionHouse: body.auctionHouse,
        tokenAccount: body.tokenAccount,
        tokenMint: body.tokenMint,
      });
      if (!onchain) {
        return NextResponse.json({ error: "This listing is no longer live on-chain." }, { status: 409 });
      }
      if (onchain.priceLamports !== body.priceLamports) {
        return NextResponse.json({ error: "On-chain price no longer matches the price shown." }, { status: 409 });
      }
    }
    const instruction = await buildMagicEdenBuyNow({
      buyerAddress: body.buyerAddress,
      tokenMint: body.tokenMint,
      priceLamports: body.priceLamports,
    });
    return NextResponse.json({ tx: instruction.tx }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build the Magic Eden buy instruction");
  }
}
