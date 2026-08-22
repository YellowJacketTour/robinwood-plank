/**
 * Server-side proxy for quoteDeBridgeCrossChainPurchase -- same reason as
 * the sibling across-quote route: the OpenSea key must never reach a
 * client bundle.
 */
import { NextRequest, NextResponse } from "next/server";
import { quoteDeBridgeCrossChainPurchase } from "@/lib/market/multichain/trading/debridge-quote";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-debridge-quote", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as {
      executorAddress?: string;
      orderHash?: string;
      destinationChainSlug?: string;
      recipient?: string;
      senderAddress?: string;
      inputAmountWei?: string;
      /** "USDC" | "USDT" -- pay with a real, live-verified BNB Chain stablecoin instead of WBNB. Omit for the original wrapped-native behavior. */
      inputCurrency?: "USDC" | "USDT";
    };
    if (
      !body.executorAddress ||
      !body.orderHash ||
      !body.destinationChainSlug ||
      !body.recipient ||
      !body.senderAddress ||
      !body.inputAmountWei
    ) {
      return NextResponse.json(
        { error: "executorAddress, orderHash, destinationChainSlug, recipient, senderAddress, and inputAmountWei are required" },
        { status: 400 }
      );
    }
    if (body.inputCurrency && body.inputCurrency !== "USDC" && body.inputCurrency !== "USDT") {
      return NextResponse.json({ error: 'inputCurrency must be "USDC" or "USDT" when provided' }, { status: 400 });
    }
    const quote = await quoteDeBridgeCrossChainPurchase({
      executorAddress: body.executorAddress,
      orderHash: body.orderHash,
      destinationChainSlug: body.destinationChainSlug,
      recipient: body.recipient,
      senderAddress: body.senderAddress,
      inputAmountWei: body.inputAmountWei,
      inputCurrency: body.inputCurrency,
    });
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build deBridge cross-chain quote");
  }
}
