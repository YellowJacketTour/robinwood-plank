/**
 * A wallet's own active listings for ONE collection on a foreign chain --
 * the "My Listings" tab equivalent. OpenSea removed its maker-filtered
 * orders endpoint (confirmed live 2026-08-18: GET /orders/{chain}/seaport/
 * listings now returns a flat 405 regardless of query params, not a
 * parameter-shape issue -- the whole path is gone). So this filters the
 * same full active-listings set fetchForeignAllListings already fetches
 * (see foreign-orders.ts) down to orders whose offerer matches the given
 * wallet -- no shortcut exists, this IS the real approach.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignAllListings } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-my-listings", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const maker = searchParams.get("maker")?.toLowerCase();

  if (!chainSlug || !collectionSlug || !maker) {
    return NextResponse.json({ error: "chainSlug, collectionSlug, and maker are required" }, { status: 400 });
  }
  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const orders = await fetchForeignAllListings({ chainSlug, collectionSlug, limit: 50 });
    const mine = orders
      .filter((o) => o.parameters.offerer.toLowerCase() === maker)
      .map((o) => {
        const item = o.parameters.offer[0];
        const priceWei = o.parameters.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0)).toString();
        return {
          orderHash: o.orderHash,
          tokenId: item?.identifierOrCriteria ?? "",
          priceWei,
          expiresAt: new Date(Number(o.parameters.endTime) * 1000).toISOString(),
        };
      });
    return NextResponse.json({ listings: mine }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to load your multichain listings");
  }
}
