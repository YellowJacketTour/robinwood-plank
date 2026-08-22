/**
 * Server-side proxy for quoteCrossChainPurchase -- same reason as the
 * sibling fulfillment-data/floor-listings routes: the OpenSea key must
 * never reach a client bundle. This is the piece that turns
 * MarketplankAcrossReceiver from "written and tested" into "actually
 * usable" -- it builds the real, submittable Across depositV3 parameters
 * a client-side wallet then sends directly to the real, audited SpokePool
 * contract (never through this server for execution, only for building
 * the calldata).
 */
import { NextRequest, NextResponse } from "next/server";
import { quoteCrossChainPurchase } from "@/lib/market/multichain/trading/across-quote";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-across-quote", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as {
      originChainId?: number;
      destinationChainSlug?: string;
      receiverAddress?: string;
      orderHash?: string;
      recipient?: string;
      inputAmount?: string;
      /** "USDC" | "USDT" -- pay with a stablecoin instead of the origin chain's wrapped-native token. Omit for the original wrapped-native behavior. */
      inputCurrency?: "USDC" | "USDT";
    };
    if (
      !body.originChainId ||
      !body.destinationChainSlug ||
      !body.receiverAddress ||
      !body.orderHash ||
      !body.recipient ||
      !body.inputAmount
    ) {
      return NextResponse.json(
        { error: "originChainId, destinationChainSlug, receiverAddress, orderHash, recipient, and inputAmount are required" },
        { status: 400 }
      );
    }
    if (body.inputCurrency && body.inputCurrency !== "USDC" && body.inputCurrency !== "USDT") {
      return NextResponse.json({ error: 'inputCurrency must be "USDC" or "USDT" when provided' }, { status: 400 });
    }
    const quote = await quoteCrossChainPurchase({
      originChainId: body.originChainId,
      destinationChainSlug: body.destinationChainSlug,
      receiverAddress: body.receiverAddress,
      orderHash: body.orderHash,
      fulfillerAddress: body.receiverAddress,
      recipient: body.recipient,
      inputAmount: body.inputAmount,
      inputCurrency: body.inputCurrency,
    });
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to build cross-chain quote");
  }
}
