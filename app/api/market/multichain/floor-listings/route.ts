/**
 * Server-side proxy for fetchForeignFloorListings -- same reason as the
 * sibling fulfillment-data route: the OpenSea key this needs must never
 * reach a client bundle. sweepForeignListings (client-side) calls this to
 * get the current floor set, then calls fulfillment-data separately for
 * each item to get a genuinely fresh, fulfillable signature immediately
 * before building the sweep transaction.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignFloorListings } from "@/lib/market/multichain/trading/foreign-orders";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-floor-listings", limit: 30, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = (await req.json()) as { chainSlug?: string; collectionSlug?: string; count?: number };
    if (!body.chainSlug || !body.collectionSlug) {
      return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
    }
    const listings = await fetchForeignFloorListings({
      chainSlug: body.chainSlug,
      collectionSlug: body.collectionSlug,
      count: Math.min(Math.max(body.count ?? 10, 1), 50),
    });
    return NextResponse.json({ listings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to fetch floor listings");
  }
}
