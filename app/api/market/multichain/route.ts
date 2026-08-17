import { NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { hasMultichainStore, listCollectionsWithSnapshots } from "@/lib/market/multichain/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The actual Cache-Control this route serves comes from next.config.ts's
 * headers() carve-out for "/api/market/multichain" — Next applies those
 * AFTER route-handler response headers, so setting Cache-Control here
 * directly gets silently overwritten by the blanket no-store every other
 * /api/* route gets by default (confirmed live: a route-level header lost to
 * that override before this was moved to next.config.ts). This app's real
 * deployment is InMotion/Passenger, not Cloudflare, so that framework-level
 * cache header — not a bolted-on edge Worker — is what makes repeat reads
 * free: any CDN, reverse proxy, or the visitor's own browser serves them
 * without touching Postgres. Data only changes once per sync
 * (scripts/refresh-market-data.ts --multichain, existing cron).
 *
 * Read-only, precomputed multi-chain collection index — see
 * deploy/inmotion/postgres/migrations/013_multichain_collections.sql and
 * lib/market/multichain/sync.ts. Serves whatever the last sync wrote;
 * NEVER live-fetches a third-party API per request (that's exactly the
 * "poll live, hit a rate limit" mistake this whole architecture exists to
 * avoid — see the Robinhood-testnet friend-test session's own postmortem).
 *
 * isVaultBacked on every row is the plank-vs-not line the frontend must
 * respect: only TRUE rows may show vault-style mechanics (burn-to-redeem,
 * rake, progression). Every row from this endpoint defaults to FALSE until a
 * collection is deliberately marked otherwise in the registry — see
 * upsertTrackedCollection in lib/market/multichain/store.ts.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, { key: "market-multichain", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!hasMultichainStore()) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED", message: "Multichain index is not configured on this deployment." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const collections = await listCollectionsWithSnapshots();
    return NextResponse.json({
      count: collections.length,
      collections: collections.map((c) => ({
        chainSlug: c.chainSlug,
        chainId: c.chainId,
        contractAddress: c.contractAddress,
        name: c.name,
        imageUrl: c.imageUrl,
        externalUrl: c.externalUrl,
        isVaultBacked: c.isVaultBacked,
        floorPriceWei: c.floorPriceWei,
        floorPriceCurrency: c.floorPriceCurrency,
        floorPriceMarketplace: c.floorPriceMarketplace,
        totalSupply: c.totalSupply,
        listedCount: c.listedCount,
        syncedAt: c.syncedAt,
        syncError: c.syncError,
      })),
    });
  } catch (error) {
    return publicError(error, "Failed to load the multichain index.");
  }
}
