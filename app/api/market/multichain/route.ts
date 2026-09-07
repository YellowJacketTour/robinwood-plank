import { NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { hasMultichainStore, listCollectionsWithSnapshotsPage, getTopByActivity, getObservedFloorChange24h } from "@/lib/market/multichain/store";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { isSolanaChainSlug, isRobinhoodChainSlug, isBitcoinChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { hasUnindexedNativeBook, primaryVenueForCollection } from "@/lib/market/multichain/venue-registry";
import { hasPostgresConfig, postgresQuery } from "@/lib/postgres";
import { getArchivalStatsBatch, archivalStatsKey } from "@/lib/market/multichain/archival-ledger";
import { CHAIN_MANIFESTS } from "@/lib/market/multichain/chains/manifest";
import { getLaneHealth, summarizeLaneHealthByChain, type ChainLaneHealth } from "@/lib/market/multichain/mesh/lane-health";

export type HubChainMeta = {
  /** manifest.statsCapable: false = no floor/listed/volume source is wired for this chain at all (zkSync). */
  statsCapable: boolean;
  /** Per-chain discovery/stats lane health (mesh_lane_health); `down` is what the hub banners. */
  laneHealth: ChainLaneHealth;
};

/**
 * AUDIT lens 1 #9/#10 (2026-09-06, Batch E6): per-chain honesty block for
 * the hub. Lane health is a best-effort read -- a failing mesh_lane_health
 * query must never take the index down, so it degrades to "no lanes seen".
 */
async function buildHubChainMeta(): Promise<Record<string, HubChainMeta>> {
  const byChain = await getLaneHealth().then((rows) => summarizeLaneHealthByChain(rows)).catch(() => ({} as Record<string, ChainLaneHealth>));
  const out: Record<string, HubChainMeta> = {};
  for (const m of CHAIN_MANIFESTS) {
    out[m.chainSlug] = { statsCapable: m.statsCapable, laneHealth: byChain[m.chainSlug] ?? { down: [], lanes: [] } };
  }
  return out;
}

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
  // 240/min: the hub's infinite scroll plus its error retries can exceed 60
  // from one household, and every read is edge-cached now (one build per
  // 30 s window), so the limit guards bursts, not cost.
  const limited = rateLimit(req, { key: "market-multichain", limit: 240, windowMs: 60_000 });
  if (limited) return limited;

  if (!hasMultichainStore()) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED", message: "Multichain index is not configured on this deployment." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Single point (2026-09-06): the hub index is the hottest read in the app
  // and one build of it is dozens of Postgres round trips (a page of the
  // catalog, one activity query per chain, native book, ledger stats). Live
  // it took 96 s on a saturated PGPOOL_MAX=4 pool and every visitor paid it
  // again. Now N visitors of the same window share one build per soft TTL
  // and get stale-while-revalidate past it -- the hub GET still reads
  // snapshots only, it just reads them once.
  const url = new URL(req.url);
  const variant = Object.fromEntries(["limit", "offset", "chains", "sort", "dir", "v"].map((k) => [k, url.searchParams.get(k) ?? ""]));
  try {
    const { edgeRead } = await import("@/lib/market/multichain/edge/read-gateway");
    const { value } = await edgeRead(
      { kind: "search", chainSlug: "all", subject: "hub-index", variant },
      () => buildHubIndex(req),
      { policy: { softTtlMs: 30_000, hardTtlMs: 5 * 60_000 } }
    );
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Private diagnostics (2026-09-06): a door/admin preview holder gets the
    // real failure text; the public still gets the generic message.
    const { cookies } = await import("next/headers");
    const { verifyDoorCookieValue, DOOR_COOKIE_NAME } = await import("@/lib/market-preview-door");
    const { verifyPreviewCookieValue, MARKET_PREVIEW_COOKIE_NAME } = await import("@/lib/market-preview-auth");
    const jar = await cookies().catch(() => null);
    const privileged = jar ? verifyDoorCookieValue(jar.get(DOOR_COOKIE_NAME)?.value) || verifyPreviewCookieValue(jar.get(MARKET_PREVIEW_COOKIE_NAME)?.value) : false;
    if (privileged) {
      return NextResponse.json(
        { error: "INTERNAL", message: "Failed to load the multichain index.", detail: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 400) },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }
    return publicError(error, "Failed to load the multichain index.");
  }
}

async function buildHubIndex(req: Request) {
  {
    const rawLimit = Number(new URL(req.url).searchParams.get("limit") ?? "5000");
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20000) : 5000;
    const rawOffset = Number(new URL(req.url).searchParams.get("offset") ?? "0");
    const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    // Real server-side chain filter + sort, finishing the wiring
    // listCollectionsWithSnapshotsPage's own chainSlugs/sortColumn/sortDir
    // params already supported -- without this, a chain tab's "genuinely
    // uncapped, keep scrolling" reachability had no way to ask the server
    // for MORE of just that one chain, only more of the whole catalog.
    const chainsParam = new URL(req.url).searchParams.get("chains");
    const chainSlugFilter = chainsParam ? chainsParam.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const sortColumn = new URL(req.url).searchParams.get("sort");
    const sortDirParam = new URL(req.url).searchParams.get("dir");
    const sortDir = sortDirParam === "asc" ? "asc" : sortDirParam === "desc" ? "desc" : null;
    const { collections, totalCount } = await listCollectionsWithSnapshotsPage({
      limit,
      offset,
      chainSlugs: chainSlugFilter,
      sortColumn,
      sortDir,
    });

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
    // REAL BUG FIXED 2026-08-24, flagged live (a refresh showed RobinWood's
    // OWN row with floor "—", listed 0 of 1,542, and its grade correctly
    // but misleadingly cratering A -> D): getListings() reads real Postgres
    // (postgresReadOrders) and CAN genuinely throw on a transient
    // connection/query hiccup -- this exact class of hiccup was directly
    // observed live elsewhere in this session's own supervisor logs
    // ("canceling statement due to statement timeout"). A bare
    // `.catch(() => [])` made that indistinguishable from "the order book
    // is genuinely empty right now," which then triggered the FULL
    // canonical-mirror fallback chain below (nativeListed === 0) -- if
    // that fallback ALSO had a bad moment at the same instant, the row
    // rendered fully null, producing an honest-looking but wrong D grade
    // for a real, healthy, 108-listing collection. A transient DB blip
    // typically clears within milliseconds, so retrying once before
    // conceding to an empty result eliminates the vast majority of these
    // false "the book is empty" moments without building a whole
    // last-known-good cache layer for this route.
    const getListingsWithRetry = async (slug: string) => {
      try {
        return await getListings(slug);
      } catch {
        try {
          return await getListings(slug);
        } catch {
          return [];
        }
      }
    };
    const bySlug = await getListingsWithRetry("robinwood");
    const byContract = await getListingsWithRetry(NFT_CONTRACT_ADDRESS.toLowerCase());
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
    const { salesStatsFromLedger } = await import("@/lib/market/chain-events");
    const nativeSales = await salesStatsFromLedger().catch(() => null);
    let canonical: Awaited<
      ReturnType<typeof import("@/lib/market/canonical-robinwood")["fetchCanonicalRobinwoodStats"]>
    > = null;
    if (nativeListed === 0 || (nativeSales?.saleCount ?? 0) === 0) {
      const { fetchCanonicalRobinwoodStats } = await import("@/lib/market/canonical-robinwood");
      canonical = await fetchCanonicalRobinwoodStats({
        hostHeader: req.headers.get("host"),
      });
    }
    if (nativeListed === 0) {
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
    const preferLocalWindow =
      (nativeSales?.sales24h ?? 0) > (canonical?.sales24h ?? 0);
    const nativeSales24h = preferLocalWindow
      ? nativeSales?.sales24h ?? null
      : canonical?.sales24h ?? nativeSales?.sales24h ?? null;
    const nativeVolume24hWei = preferLocalWindow
      ? nativeSales?.volume24hWei ?? null
      : canonical?.volume24hWei ?? nativeSales?.volume24hWei ?? null;
    const nativeAddr = NFT_CONTRACT_ADDRESS.toLowerCase();
    const nativeFloorChange = await getObservedFloorChange24h(
      "robinhood",
      NFT_CONTRACT_ADDRESS,
      "marketplank"
    ).catch(() => null);
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
      adapter: "robinhood-native",
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
      volume24hWei: nativeVolume24hWei,
      sales24h: nativeSales24h,
      volume7dWei: nativeSales?.volume7dWei ?? canonical?.volume7dWei ?? null,
      sales7d: nativeSales?.sales7d ?? canonical?.sales7d ?? null,
      volume30dWei: nativeSales?.volume30dWei ?? canonical?.volume30dWei ?? null,
      sales30d: nativeSales?.sales30d ?? canonical?.sales30d ?? null,
      holderCount: nativeHolders,
      floorChangePct: nativeFloorChange?.changePct ?? null,
      floorChangeEvidence: nativeFloorChange,
      floorChangeStatus: nativeFloorChange
        ? "observed-24h"
        : nativeFloor != null
          ? "collecting-baseline"
          : null,
      isNativeHome: true,
      primaryVenue: primaryVenueForCollection("robinhood", "marketplank"),
    };

    let cryptoPunksNativeBookIndexed = false;
    let cryptoPunksNativeStats: { listedCount: number; floorWei: string | null } | null = null;
    if (hasPostgresConfig()) {
      const coverage = await postgresQuery<{ indexed: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM plank_market_coverage
           WHERE chain_slug = 'eth-mainnet' AND venue_id = 'cryptopunks-native'
             AND capability = 'listings' AND status = 'indexed'
         ) AS indexed`
      ).catch(() => ({ rows: [] }));
      cryptoPunksNativeBookIndexed = coverage.rows[0]?.indexed === true;
      if (cryptoPunksNativeBookIndexed) {
        const { getCryptoPunksNativeBookStats } = await import("@/lib/market/multichain/native-market-adapters/cryptopunks");
        cryptoPunksNativeStats = await getCryptoPunksNativeBookStats().catch(() => null);
      }
    }

    // Real collection_archival_stats read (see archival-ledger.ts's own
    // "API exposure" header) -- ONE batched query for the whole page rather
    // than one query per collection. jobProcessing is deliberately omitted
    // on this route (see getArchivalStatsBatch's header): checking
    // plank_data_jobs.status='running' per-row would mean querying against
    // up to 5000 subjects on every rankings load; that check is only cheap
    // enough on the single-collection detail route, so it lives there.
    const archivalByKey = await getArchivalStatsBatch(
      collections.map((c) => ({ chainSlug: c.chainSlug, collectionKey: c.contractAddress }))
    ).catch(() => new Map());

    const mapped = collections.map((c) => {
      const isCryptoPunks = c.chainSlug === "eth-mainnet"
        && c.contractAddress.toLowerCase() === "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
      return ({
        chainSlug: c.chainSlug,
        chainId: c.chainId,
        contractAddress: c.contractAddress,
        adapter: c.adapter,
        name: c.name,
        imageUrl: c.imageUrl,
        externalUrl: c.externalUrl,
        isVaultBacked: c.isVaultBacked,
        floorPriceWei: isCryptoPunks && cryptoPunksNativeStats ? cryptoPunksNativeStats.floorWei : c.floorPriceWei,
        floorPriceCurrency: isCryptoPunks && cryptoPunksNativeStats?.floorWei ? "ETH" : c.floorPriceCurrency,
        floorPriceMarketplace: isCryptoPunks && cryptoPunksNativeStats ? "cryptopunks-native" : c.floorPriceMarketplace,
        totalSupply: isCryptoPunks ? 10_000 : c.totalSupply,
        // REAL BUG FIXED 2026-08-24, flagged live ("the crypto punks grade
        // is still blank on rankings"): a native-book-owned collection
        // whose LATEST sync attempt happens to be failing (transient RPC
        // hiccup, a real one live-reproduced for CryptoPunks specifically
        // -- plank_market_coverage showed status='error' from 13+ hours
        // ago) got its listedCount unconditionally nulled here, even
        // though a real, correct, only-slightly-stale value (1149,
        // confirmed via direct DB query) already sat in
        // plank_multichain_snapshots from an earlier successful sync.
        // hasGradeEvidence() in GlobalMarketHub.tsx requires a non-null
        // positive listedCount to grade a row at all -- nulling a real
        // cached number over a transient resync failure is exactly the
        // same "real failure treated as confirmed-bad" bug already fixed
        // this session for RobinWood's own listings and the Solana DAS
        // pool. Now only nulls when there's truly NEVER been a real
        // value recorded (c.listedCount itself null), falling back to the
        // last-known-good cached figure otherwise -- a resync failure
        // degrades to "possibly stale," never "blank."
        listedCount:
          isCryptoPunks && cryptoPunksNativeStats
            ? cryptoPunksNativeStats.listedCount
          : hasUnindexedNativeBook(c.chainSlug, c.contractAddress) && !cryptoPunksNativeBookIndexed
            ? (c.listedCount ?? null)
            : c.listedCount === 0 && c.totalSupply == null && !c.floorPriceWei && !c.volume24hWei
            ? null
            : c.listedCount,
        syncedAt: c.syncedAt,
        // AUDIT lens 1 #8 / fabrication (2026-09-06): the freshness dot and
        // DataSourceChip read THIS, not syncedAt, which every partial writer
        // bumps. Null = no real floor observation recorded for this row.
        floorObservedAt: c.floorObservedAt ?? null,
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
          // AUDIT lens 1 fabrication (2026-09-06): the comment above already
          // said Bitcoin must be FALSE while mainnet buying is gated; the code
          // disagreed. Honoured now via the same flag the buy route checks.
          (isBitcoinChainSlug(c.chainSlug) && process.env.NATIVE_BITCOIN_MAINNET_ENABLED === "true"),
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
        floorChangeEvidence: null,
        isNativeHome: false,
        // Real venue-registry lookup (Issue 4, inline completeness UX --
        // see docs/marketplank/GROK-FINDINGS-biggest-issues-unified-
        // vision-2026-08-25.md) -- resolved server-side from the same
        // c.adapter/floorPriceMarketplace this row's own numbers actually
        // came from, never guessed client-side. Null only when this
        // chain has no registered venue at all.
        primaryVenue: primaryVenueForCollection(c.chainSlug, c.floorPriceMarketplace ?? c.adapter ?? null),
        archival: (() => {
          const a = archivalByKey.get(archivalStatsKey(c.chainSlug, c.contractAddress));
          if (!a) return null;
          return {
            archivalScore: a.archivalScore,
            scoreMethod: a.scoreMethod,
            tokensEverHydrated: a.tokensEverHydrated,
            knownSupply: a.knownSupply,
            lastArchivedAt: a.lastArchivedAt,
          };
        })(),
        });
    });
    const withoutDupNative = mapped.filter((c) => !(isRobinhoodChainSlug(c.chainSlug) && c.contractAddress.toLowerCase() === nativeAddr));
    // Only the very first page (offset 0) of an unfiltered-or-robinhood-
    // including request gets the synthetic native row prepended -- infinite
    // scroll now calls this route again with a growing offset to fetch MORE
    // of the same window, and re-prepending it on every later page would
    // duplicate it in the client's appended list.
    const includeNativeRow = offset === 0 && (!chainSlugFilter || chainSlugFilter.includes("robinhood"));
    const windowCollections = includeNativeRow ? [nativeRow, ...withoutDupNative] : withoutDupNative;
    const chains = await buildHubChainMeta();
    return {
      count: windowCollections.length,
      // Per-chain honesty (Batch E6): statsCapable + lane health, keyed by chain slug.
      chains,
      // Real total tracked-collection count (all 317k+, not just this
      // window) so the UI can honestly show "showing N of totalCount"
      // instead of implying this response IS the whole catalog. See
      // listCollectionsWithSnapshotsPage's header for why this response is
      // now bounded at all.
      totalCount: includeNativeRow ? totalCount + 1 : totalCount,
      limit,
      offset,
      collections: windowCollections,
    };
  }
}
