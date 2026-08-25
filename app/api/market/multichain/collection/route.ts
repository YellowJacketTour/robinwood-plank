/**
 * Collection identity + snapshot stats without depending on a live order book.
 * Featured-card clicks were dying in /listings when UniSat/OpenSea 500'd.
 */
import { NextRequest, NextResponse } from "next/server";
import { getTrackedCollection, getCollectionSupplyStats, getCollectionMarketStats, updateHolderCount } from "@/lib/market/multichain/store";
import { isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
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
    const { prioritizeCollectionDemand } = await import("@/lib/market/multichain/collection-demand");
    void prioritizeCollectionDemand(chainSlug, tracked.contractAddress).catch(() => {});
    const supply = await getCollectionSupplyStats(chainSlug, collectionSlug).catch(() => null);
    const marketStats = await getCollectionMarketStats(chainSlug, collectionSlug).catch(() => null);
    let holderCount = supply?.holderCount ?? null;
    let listedCount = supply?.listedCount ?? null;
    let totalSupply = supply?.totalSupply ?? null;
    let floorPriceWei = supply?.floorPriceWei ?? null;
    let floorPriceCurrency = supply?.floorPriceCurrency ?? null;
    if (chainSlug === "eth-mainnet" && tracked.contractAddress.toLowerCase() === "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb") {
      // REAL BUG FIXED 2026-08-24: this call had no .catch at all, unlike
      // every other live-source read on this route -- a transient Postgres
      // hiccup here (the same class of failure already fixed this session
      // for the rankings route's own CryptoPunks branch) threw the WHOLE
      // route into publicError, discarding the already-fetched, already-
      // cached `supply` fields (listedCount/floorPriceWei/totalSupply, from
      // getCollectionSupplyStats above -- itself reading the durable
      // plank_multichain_snapshots row this native table's own successful
      // syncs keep updated) instead of falling back to them. Now: only
      // override the cached values when the native read actually succeeds;
      // a transient failure keeps showing the last real cached figures
      // rather than failing the whole collection page.
      const { getCryptoPunksNativeBookStats } = await import("@/lib/market/multichain/native-market-adapters/cryptopunks");
      const native = await getCryptoPunksNativeBookStats().catch(() => null as { listedCount: number; floorWei: string | null } | null);
      totalSupply = 10_000;
      if (native) {
        listedCount = native.listedCount;
        floorPriceWei = native.floorWei;
        floorPriceCurrency = native.floorWei == null ? null : "ETH";
      }
    }
    if (isSolanaChainSlug(chainSlug)) {
      // REAL BUG FIXED 2026-08-25 (alpha-readiness audit, HIGH: "rate-limit
      // assumptions look built for a single-developer dev loop"): this call
      // had ZERO caching -- every single page view of a Solana collection
      // hit Magic Eden's live stats endpoint directly, uncoalesced. Under
      // concurrent public traffic, N visitors on the same collection made N
      // upstream calls. Wrapped in getOrRefresh -- see its own header for
      // the singleflight + stale-while-revalidate mechanism (Facebook
      // memcache leases / RFC 5861), backed by a Postgres advisory lock so
      // multiple server processes also coalesce, not just concurrent
      // requests within one.
      const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
      const stats = await getOrRefresh<{ uniqueHolders?: number; listedCount?: number } | null>(
        `magiceden-stats:${chainSlug}:${collectionSlug}`,
        { softTtlMs: 60_000, hardTtlMs: 10 * 60_000 },
        async () => {
          // Throw, don't return null, on failure -- getOrRefresh only
          // writes to cache on a resolved value, so a thrown error here
          // never poisons the cache with a false "no stats" result that
          // would then get served as real for up to hardTtlMs. Same
          // transient-failure-must-not-overwrite-cache discipline as this
          // session's earlier CryptoPunks fixes.
          const me = await fetch(
            `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(collectionSlug)}/stats`,
            { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
          );
          if (!me.ok) throw new Error(`magiceden stats HTTP ${me.status}`);
          return (await me.json()) as { uniqueHolders?: number; listedCount?: number };
        }
      ).catch(() => null);
      if (stats) {
        if (typeof stats.uniqueHolders === "number" && Number.isFinite(stats.uniqueHolders)) {
          holderCount = stats.uniqueHolders;
          await updateHolderCount(chainSlug, collectionSlug, holderCount).catch(() => {});
        }
        if (typeof stats.listedCount === "number" && Number.isFinite(stats.listedCount)) {
          listedCount = stats.listedCount;
        }
      }
    }
    if (totalSupply == null) {
      const { hasForeignRarityStore, getForeignTraitIndex } = await import("@/lib/market/multichain/foreign-rarity-store");
      if (hasForeignRarityStore()) {
        const idx = await getForeignTraitIndex(chainSlug, collectionSlug).catch(() => null);
        if (idx && idx.sampleSize > 0) totalSupply = idx.sampleSize;
      }
    }
    return NextResponse.json(
      {
        collection: {
          slug: tracked.contractAddress,
          name: tracked.name ?? tracked.contractAddress,
          imageUrl: tracked.imageUrl,
          contractAddress: tracked.contractAddress,
          listedCount,
          totalSupply,
          holderCount,
          floorPriceWei,
          floorPriceCurrency,
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
