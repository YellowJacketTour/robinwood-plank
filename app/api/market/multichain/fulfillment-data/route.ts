/**
 * Server-side proxy for fetchListingFulfillmentData -- the OpenSea key
 * that function needs must never reach a client bundle (see
 * lib/market/opensea.ts's own header). This is why
 * lib/market/multichain/trading/foreign-fulfill.ts (client-side, runs in
 * the browser for wallet signing) calls THIS route instead of importing
 * foreign-orders.ts directly -- that direct-import mistake was caught live
 * by `next build` itself: fetchListingFulfillmentData -> getOpenSeaApiKey
 * -> durable-kv.ts -> lib/postgres.ts (the `pg` driver, Node-only,
 * requires `tls`) very nearly got bundled into the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchListingFulfillmentData } from "@/lib/market/multichain/trading/foreign-orders";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * UNLIKE the sibling /api/market/multichain route (which deliberately
 * serves only precomputed sync data, never live-fetches a third party per
 * request), THIS route must fetch live: the signed order data it proxies
 * is only valid immediately before signing (see foreign-orders.ts's header
 * on why the cached summary data has no usable signature at all). No-store
 * is correct here, not a gap.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-fulfillment", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as { chainSlug?: string; orderHash?: string; fulfillerAddress?: string };
    if (!body.chainSlug || !body.orderHash || !body.fulfillerAddress) {
      return NextResponse.json({ error: "chainSlug, orderHash, and fulfillerAddress are required" }, { status: 400 });
    }
    const order = await fetchListingFulfillmentData({
      chainSlug: body.chainSlug,
      orderHash: body.orderHash,
      fulfillerAddress: body.fulfillerAddress,
    });
    return NextResponse.json(order, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to fetch fulfillment data");
  }
}
