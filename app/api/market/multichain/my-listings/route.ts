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
import { fetchForeignAllListings, resolveOpenSeaCollectionSlug } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getListings } from "@/lib/market/orders-store";
import { getCollectionAsync } from "@/lib/market/collections-server";
import { publicError, rateLimit } from "@/lib/security";
import { isNonEvmChainSlug, isRobinhoodChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

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

  // Robinhood Chain's own book -- same pattern as listings/route.ts's
  // "robinhood" branch, filtered down to this wallet's own orders.
  if (isRobinhoodChainSlug(chainSlug)) {
    try {
      const collection = await getCollectionAsync(collectionSlug);
      if (!collection) {
        return NextResponse.json({ error: "NOT_FOUND", message: "Unknown Robinhood-Chain collection." }, { status: 404 });
      }
      const native = await getListings(collectionSlug);
      const mine = native
        .filter((l) => l.maker.toLowerCase() === maker)
        .map((l) => ({
          orderHash: l.id,
          tokenId: l.tokenId,
          priceWei: l.priceWei,
          expiresAt: l.expiresAt,
        }));
      return NextResponse.json({ listings: mine }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return publicError(error, "Failed to load your Robinhood-Chain listings");
    }
  }

  // SOLANA / BITCOIN -- no LISTING (sell-side) instruction is wired for
  // these venues in this pass (magiceden-solana-trade.ts's buildMagicEdenList
  // and unisat-ordinals-trade.ts's createUniSatListing exist but nothing
  // calls them yet), so there is honestly nothing this wallet could have
  // listed through this app for these chains -- real empty, not a guess.
  if (isNonEvmChainSlug(chainSlug)) {
    return NextResponse.json({ listings: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  if (!foreignChainByChainSlug(chainSlug)) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const chain = foreignChainByChainSlug(chainSlug)!;
    // See resolveOpenSeaCollectionSlug's header (foreign-orders.ts) --
    // every card links here with a contract address, but OpenSea's
    // /listings/collection/{slug}/all endpoint needs OpenSea's own slug.
    const openSeaSlug = /^0x[0-9a-fA-F]{40}$/.test(collectionSlug)
      ? ((await resolveOpenSeaCollectionSlug(chain.openSeaChain, collectionSlug)) ?? collectionSlug)
      : collectionSlug;
    const orders = await fetchForeignAllListings({ chainSlug, collectionSlug: openSeaSlug, limit: 50 });
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
