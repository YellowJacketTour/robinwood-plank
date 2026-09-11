/**
 * Collection identity + snapshot stats without depending on a live order book.
 * Featured-card clicks were dying in /listings when UniSat/OpenSea 500'd.
 */
import { publicCollectionViews, type SharedView } from "@/lib/market/multichain/shared-view";
import { edgeRead } from "@/lib/market/multichain/edge/read-gateway";
import { normalizeContractAddress } from "@/lib/market/multichain/collection-key";
import { after, NextRequest, NextResponse } from "next/server";
import { getTrackedCollection, getCollectionSupplyStats, getCollectionMarketStats, updateHolderCount } from "@/lib/market/multichain/store";
import { isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { publicError, rateLimit } from "@/lib/security";
import { primaryVenueForCollection } from "@/lib/market/multichain/venue-registry";
import { getArchivalStatsForCollection } from "@/lib/market/multichain/archival-ledger";
import { readCollectionProfile } from "@/lib/market/multichain/collection-profile";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-collection", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  const { searchParams } = new URL(req.url);
  const chainSlug = searchParams.get("chainSlug");
  const collectionSlug = searchParams.get("collectionSlug");
  // Initial page reads use stored snapshots; the mesh refreshes venue data.
  const projectionOnly = searchParams.get("projection") === "1";
  if (!chainSlug || !collectionSlug) {
    return NextResponse.json({ error: "chainSlug and collectionSlug are required" }, { status: 400 });
  }
  try {
    const key = JSON.stringify([chainSlug, normalizeContractAddress(chainSlug, collectionSlug), projectionOnly]);
    const view = await publicCollectionViews.read(key, async () => {
      const result = await edgeRead<SharedView<Awaited<ReturnType<typeof buildCollection>>>>(
        {kind:"collection-meta",chainSlug,subject:normalizeContractAddress(chainSlug,collectionSlug),variant:{format:"shared-view-1",projection:projectionOnly}},
        async () => ({value:await buildCollection(chainSlug,collectionSlug,projectionOnly),capturedAt:Date.now()}),
        {policy:{softTtlMs:10_000,hardTtlMs:5*60_000}},
      );
      return result.value;
    }, {freshMs:1000,retainMs:5*60_000,defer:work=>after(work)});
    return NextResponse.json({...view.value, delivery:{capturedAt:new Date(view.capturedAt).toISOString(),ageMs:Math.max(0,Date.now()-view.capturedAt)}},
      {headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    if (error instanceof CollectionNotFound) return NextResponse.json({error:"NOT_FOUND"},{status:404});
    return publicError(error,"Failed to load collection");
  }
}

class CollectionNotFound extends Error {}
async function buildCollection(chainSlug:string, collectionSlug:string, projectionOnly:boolean) {
    const tracked = await getTrackedCollection(chainSlug, collectionSlug);
    if (!tracked) {
      throw new CollectionNotFound();
    }
    const { prioritizeCollectionDemand } = await import("@/lib/market/multichain/collection-demand");
    // Real bug found live 2026-08-25 ("this isnt live time updating"):
    // this silently swallowed EVERY real error with no logging at all --
    // a genuine failure here (the exact symptom reported: a real page
    // visit never re-enqueuing real, incomplete work) was completely
    // invisible, indistinguishable from "nothing needed doing." A demand
    // signal is best-effort by design (never worth failing the page
    // over), but best-effort must still mean "logged and moved on," never
    // "silently vanished."
    after(() => prioritizeCollectionDemand(chainSlug, tracked.contractAddress).catch((error) => {
      console.error(
        `[collection-route] prioritizeCollectionDemand failed for ${chainSlug}:${tracked.contractAddress}:`,
        error instanceof Error ? error.message : error
      );
    }));
    // A failed database read is not an absent snapshot. Reject the refresh
    // so the client keeps its last successful response instead of caching
    // invented empty statistics for any collection or chain.
    const [supply, marketStats, profile] = await Promise.all([
      getCollectionSupplyStats(chainSlug, collectionSlug),
      getCollectionMarketStats(chainSlug, collectionSlug),
      readCollectionProfile(chainSlug, tracked.contractAddress),
    ]);
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
    if (!projectionOnly && isSolanaChainSlug(chainSlug)) {
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
        { softTtlMs: 60_000, hardTtlMs: 10 * 60_000, provider: "magiceden" },
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
    // Real fix, 2026-08-25 ("obviously unacceptable... simpler
    // contagion"): a max-observed-token-id-based known_supply inference
    // can overstate the real total for a collection with genuine gaps in
    // its id range (confirmed live: OpenSea's own API returns "Item with
    // identifier 5 not found" for a real Lil Pudgys id our own inference
    // assumed existed) -- permanently capping the displayed score below
    // 100% even once every real token is captured. Real on-chain
    // totalSupply() is authoritative ground truth; singleflight-cached
    // (long TTL -- this changes on human timescales at most) so this
    // costs one real chain read per collection per cache window, not per
    // page view, matching every other live upstream call on this route.
    const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
    // A cold RPC/cache lease must never hold the collection response.
    after(() => getOrRefresh<number | null>(
      `known-supply-correction:${chainSlug}:${tracked.contractAddress.toLowerCase()}`,
      { softTtlMs: 30 * 60_000, hardTtlMs: 24 * 60 * 60_000 },
      async () => {
        const { correctKnownSupplyFromChain } = await import("@/lib/market/multichain/archival-ledger");
        return correctKnownSupplyFromChain(chainSlug, tracked.contractAddress);
      }
    ).then(() => undefined).catch(() => undefined));
    // Real collection_archival_stats read (see archival-ledger.ts's own
    // "API exposure" header) -- a single indexed lookup plus a cheap
    // plank_data_jobs 'running' check, both trivial at single-collection
    // scale. Null/omitted (not fabricated) when no ledger row exists yet.
    const archival = await getArchivalStatsForCollection(chainSlug, collectionSlug);
    return {
        collection: {
          slug: tracked.contractAddress,
          name: tracked.name ?? tracked.contractAddress,
          imageUrl: tracked.imageUrl,
          contractAddress: tracked.contractAddress,
          externalUrl: tracked.externalUrl,
          creatorHandle: tracked.creatorHandle,
          creatorAddress: tracked.creatorAddress,
          creatorEns: tracked.creatorEns,
          profile,
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
          // Real venue-registry lookup (Issue 4, inline completeness UX --
          // see docs/marketplank/GROK-FINDINGS-biggest-issues-unified-
          // vision-2026-08-25.md) -- resolved server-side from this
          // collection's own recorded adapter, never guessed client-side.
          primaryVenue: primaryVenueForCollection(chainSlug, tracked.adapter ?? null),
          archival: archival
            ? {
                archivalScore: archival.archivalScore,
                scoreMethod: archival.scoreMethod,
                tokensEverHydrated: archival.tokensEverHydrated,
                knownSupply: archival.knownSupply,
                lastArchivedAt: archival.lastArchivedAt,
                jobProcessing: archival.jobProcessing ?? false,
                // Honest coverage (AUDIT lens 4 #5, 2026-09-07): three counters +
                // the provisional flag the bar and the rarity route agree on.
                metadataCounters: archival.metadataCounters ?? null,
                traitsCoverage: archival.traitsCoverage ?? null,
                metadataProvisional: archival.metadataProvisional ?? null,
                // Real, separate metadata (L3) signal -- see
                // ArchivalApiShape's own header for why this must never be
                // blended into archivalScore/tokensEverHydrated above.
                metadataTokens: archival.metadataTokens ?? null,
                metadataCoverage: archival.metadataCoverage ?? null,
              }
            : null,
        },
    };
}
