import { NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { hasMultichainStore, listCollectionsWithSnapshots, getTopByActivity } from "@/lib/market/multichain/store";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isSolanaChainSlug, isRobinhoodChainSlug, isBitcoinChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

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

    // Real 7-day activity (real observed Transfer-log counts, see
    // evm-log-scan.ts -- not a guessed/fabricated $ volume figure, which
    // no free source actually provides, see rarity-index-runner.ts's own
    // header on DeFiLlama's real limits) -- the volume half of the
    // "volume + floor hybrid" default sort the hub uses. One query per
    // distinct EVM chain represented, not per collection.
    const chainSlugs = [...new Set(collections.map((c) => c.chainSlug))].filter((s) => foreignChainByChainSlug(s));
    const activityByChain = await Promise.all(
      chainSlugs.map(async (slug) => [slug, await getTopByActivity(slug, 7, 500).catch(() => [])] as const)
    );
    const activityByContract = new Map<string, number>();
    for (const [chainSlug, rows] of activityByChain) {
      for (const row of rows) activityByContract.set(`${chainSlug}:${row.contractAddress.toLowerCase()}`, row.totalTransfers);
    }

    const { NFT_CONTRACT_ADDRESS } = await import("@/lib/mint-contract");
    const { getListings } = await import("@/lib/market/orders-store");
    const bySlug = await getListings("robinwood").catch(() => []);
    const byContract = await getListings(NFT_CONTRACT_ADDRESS.toLowerCase()).catch(() => []);
    const nativeListings = bySlug.length >= byContract.length ? bySlug : byContract;
    let nativeFloor = nativeListings.reduce<bigint | null>((min, l) => {
      try {
        const p = BigInt(l.priceWei);
        return min == null || p < min ? p : min;
      } catch {
        return min;
      }
    }, null);
    let nativeListed = nativeListings.length;
    if (nativeListed === 0) {
      const { fetchCanonicalRobinwoodStats } = await import("@/lib/market/canonical-robinwood");
      const canonical = await fetchCanonicalRobinwoodStats({
        hostHeader: req.headers.get("host"),
      });
      if (canonical) {
        nativeListed = canonical.listedCount;
        if (canonical.floorPriceWei) {
          try {
            nativeFloor = BigInt(canonical.floorPriceWei);
          } catch {
            /* keep null */
          }
        }
      }
    }
    const nativeAddr = NFT_CONTRACT_ADDRESS.toLowerCase();
    const { ROBINWOOD_TOTAL_SUPPLY, ROBINWOOD_X_HANDLE } = await import("@/lib/mint-contract");
    let nativeHolders: number | null = null;
    try {
      const { getOwnerIndex, uniqueWalletCount } = await import("@/lib/market/owner-index");
      const index = await getOwnerIndex(NFT_CONTRACT_ADDRESS);
      const n = index ? uniqueWalletCount(index.owners) : 0;
      nativeHolders = n > 0 ? n : null;
    } catch {
      nativeHolders = null;
    }
    const nativeRow = {
      chainSlug: "robinhood" as const,
      chainId: 4663,
      contractAddress: NFT_CONTRACT_ADDRESS,
      name: "RobinWood",
      imageUrl: "/images/plank-logo.webp",
      externalUrl: "/market",
      isVaultBacked: true,
      floorPriceWei: nativeFloor != null ? nativeFloor.toString() : null,
      floorPriceCurrency: "ETH",
      floorPriceMarketplace: "marketplank",
      totalSupply: ROBINWOOD_TOTAL_SUPPLY,
      listedCount: nativeListed,
      syncedAt: new Date().toISOString(),
      syncError: null as string | null,
      tradeable: true,
      recentActivity: 0,
      creatorHandle: ROBINWOOD_X_HANDLE,
      creatorAddress: null as string | null,
      creatorEns: null as string | null,
      volume24hWei: null as string | null,
      sales24h: null as number | null,
      volume7dWei: null as string | null,
      sales7d: null as number | null,
      volume30dWei: null as string | null,
      sales30d: null as number | null,
      holderCount: nativeHolders,
      floorChangePct: null as number | null,
      isNativeHome: true,
    };

    const mapped = collections.map((c) => ({
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
        listedCount:
          c.listedCount === 0 && c.totalSupply == null && !c.floorPriceWei && !c.volume24hWei
            ? null
            : c.listedCount,
        syncedAt: c.syncedAt,
        syncError: c.syncError,
        // TRUE for: the 7 real foreign EVM chains (Seaport buy/sweep/send/
        // offers), Robinhood Chain itself (native order book -- see
        // buyRobinhoodListingNow/acceptRobinhoodOfferNow in
        // foreign-fulfill.ts, built and live-verified this session), and
        // Solana (real Magic Eden buy via buySolanaListingNow). FALSE for
        // Bitcoin Ordinals: buyBitcoinListingNow exists but is key-gated
        // (UNISAT_API_KEY) and returns 503 without one -- the UI must not
        // offer a "buy" affordance this deployment can't actually fulfill,
        // matching this route's own honest-not-fabricated posture
        // elsewhere (see floorChangePct below).
        tradeable:
          Boolean(foreignChainByChainSlug(c.chainSlug)) ||
          isRobinhoodChainSlug(c.chainSlug) ||
          isSolanaChainSlug(c.chainSlug) ||
          isBitcoinChainSlug(c.chainSlug),
        recentActivity: activityByContract.get(`${c.chainSlug}:${c.contractAddress.toLowerCase()}`) ?? 0,
        creatorHandle: c.creatorHandle,
        creatorAddress: c.creatorAddress,
        creatorEns: c.creatorEns,
        volume24hWei: c.volume24hWei,
        sales24h: c.sales24h,
        // Real OpenSea 7d/30d intervals, same response as 24h (see
        // updateCollectionMarketStats's header) -- null, not zero, until a
        // collection has been through that stats pass at least once.
        volume7dWei: c.volume7dWei,
        sales7d: c.sales7d,
        volume30dWei: c.volume30dWei,
        sales30d: c.sales30d,
        // Real distinct-owner count (Alchemy getOwnersForContract, EVM
        // chains only) -- null for chains/collections without a fetched
        // count yet, never a fabricated 0.
        holderCount: c.holderCount,
        // Real, computed from this app's own prior observation (see
        // updateCollectionMarketStats's header) -- OpenSea's stats
        // endpoint has no floor-change field at all.
        floorChangePct:
          c.floorChangePct != null && Number.isFinite(c.floorChangePct)
            ? c.floorChangePct
            : c.previousFloorPriceWei && c.floorPriceWei && BigInt(c.previousFloorPriceWei) > BigInt(0)
              ? (Number(BigInt(c.floorPriceWei) - BigInt(c.previousFloorPriceWei)) / Number(BigInt(c.previousFloorPriceWei))) * 100
              : null,
        isNativeHome: false,
      }));
    const withoutDupNative = mapped.filter((c) => !(isRobinhoodChainSlug(c.chainSlug) && c.contractAddress.toLowerCase() === nativeAddr));
    return NextResponse.json({
      count: withoutDupNative.length + 1,
      collections: [nativeRow, ...withoutDupNative],
    });
  } catch (error) {
    return publicError(error, "Failed to load the multichain index.");
  }
}
