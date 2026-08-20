/**
 * Collection identity + snapshot stats without depending on a live order book.
 * Featured-card clicks were dying in /listings when UniSat/OpenSea 500'd.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackedCollection, getCollectionSupplyStats, getCollectionMarketStats } from "@/lib/market/multichain/store";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-collection", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  try {
    const tracked = await getTrackedCollection(chainSlug, collectionSlug);
    if (!tracked) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const supply = await getCollectionSupplyStats(chainSlug, collectionSlug).catch(() => null);
    const marketStats = await getCollectionMarketStats(chainSlug, collectionSlug).catch(() => null);
    return NextResponse.json(
      {
        collection: {
          slug: tracked.contractAddress,
          name: tracked.name ?? tracked.contractAddress,
          imageUrl: tracked.imageUrl,
          contractAddress: tracked.contractAddress,
          listedCount: supply?.listedCount ?? null,
          totalSupply: supply?.totalSupply ?? null,
          holderCount: supply?.holderCount ?? null,
          floorPriceWei: supply?.floorPriceWei ?? null,
          volume24hWei: marketStats?.volume24hWei ?? null,
          sales24h: marketStats?.sales24h ?? null,
          volume7dWei: marketStats?.volume7dWei ?? null,
          sales7d: marketStats?.sales7d ?? null,
          volume30dWei: marketStats?.volume30dWei ?? null,
          sales30d: marketStats?.sales30d ?? null,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load collection");
  }
}
