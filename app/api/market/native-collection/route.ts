/**
 * Server-side resolver for getCollectionAsync -- exists because that
 * function's Robinhood-Chain fallback path queries Postgres directly
 * (via lib/market/multichain/store.ts), which client code can never do.
 * Real callers: MultichainCollectionView.tsx and foreign-fulfill.ts,
 * whenever chainSlug is "robinhood" (see foreign-chain-registry.ts's own
 * header on why Robinhood Chain is the one chain excluded from
 * FOREIGN_CHAINS, and lib/market/collections.ts's own header on why
 * getCollectionAsync's Robinhood-Chain fallback exists at all).
 *
 * Read-only, no state-changing action lives behind this route -- it
 * exists purely so the browser can learn a collection's real
 * fee/royalty/token-standard config before building a fulfillOrder call,
 * the exact same information native RobinWood trades already get from
 * the hardcoded MARKET_COLLECTIONS entry client-side.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-native-collection", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);
    const slug = searchParams.get("slug");
    if (!slug) {
      return NextResponse.json({ error: "slug is required" }, { status: 400 });
    }
    const collection = await getCollectionAsync(slug);
    if (!collection) {
      return NextResponse.json({ error: "NOT_FOUND", message: "Unknown or unlisted collection." }, { status: 404 });
    }
    return NextResponse.json({ collection }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to resolve collection.");
  }
}
