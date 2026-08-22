/**
 * Server-side proxy for OpenSea's real offer fulfillment-data endpoint
 * (POST /v2/offers/fulfillment_data, confirmed live 2026-08-18 via a real
 * "Order not found" error for a fake hash -- proves the request shape is
 * right, not a guess). Same reason every OpenSea-calling route here is
 * server-side: the API key must never reach the client bundle.
 *
 * Mirrors fetchListingFulfillmentData's own reasoning
 * (foreign-orders.ts): the summary/display offer data carries no usable
 * signature, so accepting an offer needs this separate, fulfiller-specific
 * call immediately before building the transaction.
 */
import { NextRequest, NextResponse } from "next/server";
import { foreignChainByChainSlug, FOREIGN_SEAPORT_ADDRESS } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-offer-fulfillment", limit: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as { chainSlug?: string; orderHash?: string; fulfillerAddress?: string; tokenId?: string };
    if (!body.chainSlug || !body.orderHash || !body.fulfillerAddress) {
      return NextResponse.json({ error: "chainSlug, orderHash, and fulfillerAddress are required" }, { status: 400 });
    }
    const chain = foreignChainByChainSlug(body.chainSlug);
    if (!chain) {
      return NextResponse.json({ error: `"${body.chainSlug}" is not a supported foreign chain` }, { status: 400 });
    }
    // No OpenSea orderbook for this chain (zkSync today) -- an order hash
    // claiming to be fulfillable here can only be a caller bug, since no
    // OpenSea order could ever legitimately reference this chain.
    if (!chain.openSeaChain) {
      return NextResponse.json({ error: `"${body.chainSlug}" has no OpenSea orderbook.` }, { status: 400 });
    }

    const key = await getOpenSeaApiKey();
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }

    const res = await fetch("https://api.opensea.io/api/v2/offers/fulfillment_data", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        offer: { hash: body.orderHash, chain: chain.openSeaChain, protocol_address: FOREIGN_SEAPORT_ADDRESS },
        fulfiller: { address: body.fulfillerAddress },
        ...(body.tokenId
          ? {
              consideration: {
                token_id: body.tokenId,
              },
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return NextResponse.json({ error: errText.slice(0, 300) }, { status: res.status });
    }
    const data = (await res.json()) as {
      fulfillment_data: { orders: Array<{ parameters: unknown; signature: string }> };
    };
    const order = data.fulfillment_data.orders[0];
    if (!order) {
      return NextResponse.json({ error: "No fulfillable order returned." }, { status: 404 });
    }
    return NextResponse.json({ parameters: order.parameters, signature: order.signature });
  } catch (error) {
    return publicError(error, "Failed to fetch offer fulfillment data");
  }
}
