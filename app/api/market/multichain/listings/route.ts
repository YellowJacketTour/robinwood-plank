/**
 * Real, cross-chain-buyable listings for ONE tracked multichain collection
 * (see plank_multichain_collections / lib/market/multichain/store.ts) --
 * normalized into the shared Listing shape (lib/market/types.ts) so the
 * SAME ListingCard/BuyConfirm/foreign-fulfill machinery already built and
 * proven for Marketplank's own collection works here unmodified.
 *
 * Server-side for the same reason as the sibling fulfillment-data/
 * floor-listings routes: the OpenSea key must never reach a client bundle.
 *
 * Deliberately a NEW surface, not merged into /api/market/orders (that
 * endpoint is scoped to ONE collection, Marketplank's own RobinWood
 * plank -- these are entirely different collections on entirely different
 * chains, tracked in a different table, with a different (much larger)
 * catalog. Mixing them would also violate the documented /market
 * (single collection, cross-venue for THAT collection) vs /discover
 * (ours-only) split -- this is neither; it's a third, new thing:
 * multi-collection, multi-chain, cross-venue-only browsing.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignAllListings } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { publicError, rateLimit } from "@/lib/security";
import type { Listing } from "@/lib/market/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-listings", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "24");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 24;

  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const orders = await fetchForeignAllListings({ chainSlug, collectionSlug, limit });
    const listings: Listing[] = orders.map((order) => {
      const item = order.parameters.offer[0];
      const priceWei = order.parameters.consideration
        .reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0))
        .toString();
      return {
        id: order.orderHash,
        collectionSlug,
        tokenId: item?.identifierOrCriteria ?? "",
        maker: order.parameters.offerer,
        priceWei,
        expiresAt: new Date(Number(order.parameters.endTime) * 1000).toISOString(),
        kind: "fixed",
        venue: "opensea",
        externalUrl: `https://opensea.io/assets/${collectionSlug}`,
        foreignChainSlug: chainSlug,
        foreignOrderHash: order.orderHash,
      };
    });
    return NextResponse.json({ listings }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load multichain listings");
  }
}
