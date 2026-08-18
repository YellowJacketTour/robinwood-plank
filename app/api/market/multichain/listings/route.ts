/**
 * Real, cross-chain-buyable listings for ONE collection on a foreign chain,
 * normalized into the shared Listing shape (lib/market/types.ts) so the SAME
 * ListingCard/BuyConfirm/foreign-fulfill machinery already built and proven
 * for Marketplank's own collection works here unmodified.
 *
 * Server-side for the same reason as the sibling fulfillment-data/
 * floor-listings routes: the OpenSea key must never reach a client bundle.
 *
 * Deliberately a NEW surface, not merged into /api/market/orders (that
 * endpoint is scoped to ONE collection, Marketplank's own RobinWood plank --
 * these are entirely different collections on entirely different chains).
 *
 * WHY THIS ALSO RETURNS COLLECTION METADATA AND PER-TOKEN ART
 * ---------------------------------------------------------------
 * A first version returned bare orders with no imageUrl, on the assumption
 * the caller could resolve art itself. Loading the real page in a real
 * browser proved otherwise: every card rendered <Image src="">, producing
 * 120 console errors and an art-less grid -- for an NFT marketplace, the
 * art IS the product (the same lesson lib/market/types.ts's own Listing
 * .imageUrl comment already records for the Robinhood-chain path: "showing
 * the collection logo for every item makes a grid look broken or fake").
 * So this route now resolves, server-side and in parallel:
 *   - the collection's real name + logo (one /collections/{slug} call), and
 *   - each DISTINCT listed token's own artwork.
 * Distinct-token dedup matters more than it looks: a real collection
 * frequently has many listings across only a handful of tokens (GRiBBiTS
 * live had 5 listings across 2 tokens), so this is typically a couple of
 * calls, not one per listing.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchForeignAllListings } from "@/lib/market/multichain/trading/foreign-orders";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { publicError, rateLimit } from "@/lib/security";
import type { Listing } from "@/lib/market/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const OPENSEA = "https://api.opensea.io/api/v2";

/** Bounds the per-token art fan-out. Distinct tokens are usually few (see header); this only guards a pathological case. */
const MAX_ART_LOOKUPS = 30;

async function openSeaJson<T>(path: string, key: string): Promise<T | null> {
  const res = await fetch(`${OPENSEA}${path}`, { headers: { "x-api-key": key, accept: "application/json" } });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-listings", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  const limitParam = Number(searchParams.get("limit") ?? "24");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 24;

  const chain = chainSlug ? foreignChainByChainSlug(chainSlug) : null;
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  if (!chain) {
    return NextResponse.json({ error: `"${chainSlug}" is not a supported foreign chain` }, { status: 400 });
  }

  try {
    const key = await getOpenSeaApiKey();
    if (!key) {
      return NextResponse.json({ error: "OpenSea API key is not configured on this deployment." }, { status: 503 });
    }

    const [rawOrders, collectionMeta] = await Promise.all([
      fetchForeignAllListings({ chainSlug, collectionSlug, limit }),
      openSeaJson<{ name?: string; image_url?: string; contracts?: Array<{ address: string; chain: string }> }>(
        `/collections/${encodeURIComponent(collectionSlug)}`,
        key
      ),
    ]);

    // ONE CARD PER TOKEN, CHEAPEST WINS.
    //
    // OpenSea's /listings/.../all returns every active order, and a single
    // token routinely carries several -- confirmed live in a real browser:
    // a 40-listing response rendered as #541 three times, #2943 four times,
    // same maker and same price each time (OpenSea re-signs/rotates an
    // order as it nears its ~11-minute expiry, so one economic listing
    // appears as many order hashes). Rendered undeduped, the grid looks
    // broken or spammy -- the same failure mode lib/market/sweep.ts's own
    // dedup already guards against for the Robinhood-chain path ("two
    // listings of the same plank can't both fill, so only the cheapest is
    // kept"). Same rule, same reason, applied here for display.
    const cheapestByToken = new Map<string, (typeof rawOrders)[number]>();
    for (const order of rawOrders) {
      const tokenId = order.parameters.offer[0]?.identifierOrCriteria;
      if (!tokenId) continue;
      const priceOf = (o: (typeof rawOrders)[number]) =>
        o.parameters.consideration.reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0));
      const existing = cheapestByToken.get(tokenId);
      if (!existing || priceOf(order) < priceOf(existing)) cheapestByToken.set(tokenId, order);
    }
    const orders = [...cheapestByToken.values()].sort((a, b) => {
      const pa = a.parameters.consideration.reduce((s, c) => s + BigInt(c.startAmount), BigInt(0));
      const pb = b.parameters.consideration.reduce((s, c) => s + BigInt(c.startAmount), BigInt(0));
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });

    const contractAddress =
      collectionMeta?.contracts?.find((c) => c.chain === chain.openSeaChain)?.address ??
      collectionMeta?.contracts?.[0]?.address ??
      orders[0]?.parameters.offer[0]?.token ??
      "";

    // Resolve each DISTINCT token's own art once (see header on why dedup matters).
    const distinctTokenIds = [
      ...new Set(orders.map((o) => o.parameters.offer[0]?.identifierOrCriteria).filter(Boolean) as string[]),
    ].slice(0, MAX_ART_LOOKUPS);

    const artEntries = await Promise.all(
      distinctTokenIds.map(async (tokenId) => {
        const nft = await openSeaJson<{ nft?: { name?: string; image_url?: string } }>(
          `/chain/${chain.openSeaChain}/contract/${contractAddress}/nfts/${tokenId}`,
          key
        );
        return [tokenId, { name: nft?.nft?.name ?? null, imageUrl: nft?.nft?.image_url ?? null }] as const;
      })
    );
    const artByToken = new Map(artEntries);

    const listings: Listing[] = orders.map((order) => {
      const item = order.parameters.offer[0];
      const tokenId = item?.identifierOrCriteria ?? "";
      const priceWei = order.parameters.consideration
        .reduce((sum, c) => sum + BigInt(c.startAmount), BigInt(0))
        .toString();
      const art = artByToken.get(tokenId);
      return {
        id: order.orderHash,
        collectionSlug,
        tokenId,
        maker: order.parameters.offerer,
        priceWei,
        expiresAt: new Date(Number(order.parameters.endTime) * 1000).toISOString(),
        kind: "fixed",
        imageUrl: art?.imageUrl ?? undefined,
        venue: "opensea",
        externalUrl: `https://opensea.io/assets/${chain.openSeaChain}/${contractAddress}/${tokenId}`,
        foreignChainSlug: chainSlug,
        foreignOrderHash: order.orderHash,
      };
    });

    return NextResponse.json(
      {
        collection: {
          slug: collectionSlug,
          name: collectionMeta?.name ?? collectionSlug,
          imageUrl: collectionMeta?.image_url ?? null,
          contractAddress,
        },
        listings,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return publicError(error, "Failed to load multichain listings");
  }
}
