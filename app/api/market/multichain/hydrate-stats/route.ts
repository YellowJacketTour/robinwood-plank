/**
 * Visible-page stats only. All logic lives in this file so the hub cannot
 * compile a second module with a duplicate binding.
 */
import { NextRequest, NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { pickOpenSeaKey } from "@/lib/market/multichain/discovery/opensea-key-pool";
import {
  updateCollectionMarketStats,
  updateCollectionSupplyFields,
  updateCollectionDisplay,
  updateCollectionFloorOnly,
  updateHolderCount,
} from "@/lib/market/multichain/store";
import { isBitcoinChainSlug, isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";
import { fetchAllOpenSeaListings } from "@/lib/market/opensea";
import { CRYPTOPUNKS_CONTRACT, getCryptoPunksNativeBookStats } from "@/lib/market/multichain/native-market-adapters/cryptopunks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CG_PLATFORM: Record<string, string> = {
  "eth-mainnet": "ethereum",
  "opt-mainnet": "optimistic-ethereum",
  "arb-mainnet": "arbitrum-one",
  "base-mainnet": "base",
  "polygon-mainnet": "polygon-pos",
  "bnb-mainnet": "binance-smart-chain",
  "avax-mainnet": "avalanche",
  "solana-mainnet": "solana",
};

function nativeToWei(v: number | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return BigInt(Math.round(v * 1e18)).toString();
}

/**
 * CryptoPunks predates ERC-721 and Seaport (see the identical guard and
 * comment in listings/route.ts). Its own contract-state book is the
 * authoritative live listedCount -- OpenSea's generic /stats endpoint
 * reports a punksOfferedForSale count of 0 for it (confirmed live), which
 * would otherwise clobber the real ~1,100-listing native count below via
 * updateCollectionSupplyFields's "0 is a real count" COALESCE semantics.
 * This is why the Global Market Hub's Grade column showed "-" for
 * CryptoPunks: gradeScore() requires a real live listedCount, and the
 * generic OpenSea pass kept overwriting the true one with a false zero.
 */
const isCryptoPunks = (chainSlug: string, contractAddress: string) =>
  chainSlug === "eth-mainnet" && contractAddress.toLowerCase() === CRYPTOPUNKS_CONTRACT;

async function refreshOne(chainSlug: string, contractAddress: string): Promise<boolean> {
  if (isCryptoPunks(chainSlug, contractAddress)) {
    try {
      const nativeStats = await getCryptoPunksNativeBookStats();
      await updateCollectionSupplyFields(chainSlug, contractAddress, {
        listedCount: nativeStats.listedCount,
        totalSupply: 10_000,
      });
      if (nativeStats.floorWei) {
        await updateCollectionFloorOnly(chainSlug, contractAddress, {
          floorPriceWei: nativeStats.floorWei,
          floorPriceCurrency: "ETH",
          floorPriceMarketplace: "cryptopunks-native",
        }).catch(() => {});
      }
    } catch {
      /* fall through to the generic path below for volume/holders only */
    }
  }

  if (isSolanaChainSlug(chainSlug)) {
    // REAL DUPLICATE OF THE SAME BUG collection/route.ts's Magic Eden stats
    // fetch was fixed for: this call had zero caching, and is the exact
    // same upstream endpoint keyed the exact same way -- so this now shares
    // that route's own cache key/TTL rather than getting an independent
    // (and independently uncoalesced) cache entry. See singleflight-cache.ts's
    // own header for the coalescing/stale-while-revalidate mechanism.
    const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
    const stats = await getOrRefresh<{ listedCount?: number; uniqueHolders?: number; floorPrice?: number | null } | null>(
      `magiceden-stats:${chainSlug}:${contractAddress}`,
      { softTtlMs: 60_000, hardTtlMs: 10 * 60_000 },
      async () => {
        const me = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(contractAddress)}/stats`, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!me.ok) throw new Error(`magiceden stats HTTP ${me.status}`);
        return (await me.json()) as { listedCount?: number; uniqueHolders?: number; floorPrice?: number | null };
      }
    ).catch(() => null);
    if (!stats) return false;
    if (typeof stats.listedCount === "number") {
      await updateCollectionSupplyFields("solana-mainnet", contractAddress, {
        listedCount: stats.listedCount,
        totalSupply: null,
      }).catch(() => {});
    }
    if (typeof stats.uniqueHolders === "number" && stats.uniqueHolders > 0) {
      await updateHolderCount("solana-mainnet", contractAddress, stats.uniqueHolders).catch(() => {});
    }
    if (typeof stats.floorPrice === "number" && stats.floorPrice > 0) {
      const wei = (BigInt(Math.round(stats.floorPrice)) * BigInt(1_000_000_000)).toString();
      await updateCollectionFloorOnly("solana-mainnet", contractAddress, {
        floorPriceWei: wei,
        floorPriceCurrency: "SOL",
        floorPriceMarketplace: "magiceden",
      }).catch(() => {});
    }
    return true;
  }

  if (isBitcoinChainSlug(chainSlug)) {
    const { unisatCollectionsAdapter } = await import("@/lib/market/multichain/adapters/unisat-collections");
    try {
      const snap = await unisatCollectionsAdapter.fetchSnapshot({
        chainSlug: "bitcoin-mainnet",
        contractAddress,
      });
      if (snap.listedCount != null || snap.totalSupply != null) {
        await updateCollectionSupplyFields("bitcoin-mainnet", contractAddress, {
          listedCount: snap.listedCount,
          totalSupply: snap.totalSupply,
        }).catch(() => {});
      }
      if (snap.floorPriceWei) {
        await updateCollectionFloorOnly("bitcoin-mainnet", contractAddress, {
          floorPriceWei: snap.floorPriceWei,
          floorPriceCurrency: "BTC",
          floorPriceMarketplace: "unisat",
        }).catch(() => {});
      }
      if (typeof snap.holderCount === "number" && snap.holderCount > 0) {
        await updateHolderCount("bitcoin-mainnet", contractAddress, snap.holderCount).catch(() => {});
      }
      return true;
    } catch {
      return false;
    }
  }

  let filled = false;
  const platform = CG_PLATFORM[chainSlug];
  if (platform) {
    const cgDemo = process.env.COINGECKO_API_KEY?.trim();
    const cgHeaders: Record<string, string> = cgDemo
      ? { accept: "application/json", "x-cg-demo-api-key": cgDemo }
      : { accept: "application/json" };
    const cg = await fetch(
      `https://api.coingecko.com/api/v3/nfts/${platform}/contract/${encodeURIComponent(contractAddress)}`,
      { headers: cgHeaders, signal: AbortSignal.timeout(12_000) }
    ).catch(() => null);
    if (cg?.ok) {
      const d = (await cg.json()) as {
        volume_24h?: { native_currency?: number };
        one_day_sales?: number;
        floor_price_24h_percentage_change?: { native_currency?: number };
        number_of_unique_addresses?: number;
        total_supply?: number;
      };
      await updateCollectionMarketStats(chainSlug, contractAddress, {
        volume24hWei: nativeToWei(d.volume_24h?.native_currency),
        sales24h: typeof d.one_day_sales === "number" ? d.one_day_sales : null,
        currentFloorPriceWei: null,
        floorChangePct:
          typeof d.floor_price_24h_percentage_change?.native_currency === "number" &&
          d.floor_price_24h_percentage_change.native_currency !== 0
            ? d.floor_price_24h_percentage_change.native_currency
            : null,
      }).catch(() => {});
      if (typeof d.number_of_unique_addresses === "number" && d.number_of_unique_addresses > 0) {
        await updateHolderCount(chainSlug, contractAddress, d.number_of_unique_addresses).catch(() => {});
      }
      filled = true;
    }
  }

  const osChain = chainSlug === "robinhood" ? "robinhood" : foreignChainByChainSlug(chainSlug)?.openSeaChain ?? null;
  const openSeaApiKey = osChain ? (await pickOpenSeaKey("live"))?.apiKey ?? null : null;
  if (!osChain || !openSeaApiKey) return filled;

  // Contract->slug identity is effectively immutable (same reasoning as
  // resolveOpenSeaCollectionSlug elsewhere) -- a long soft TTL means a
  // collection hydrated repeatedly (this route is invoked per-row from a
  // hub page view) resolves its slug once, not on every hydrate call.
  const { getOrRefresh } = await import("@/lib/market/multichain/singleflight-cache");
  const identKey = `opensea-collection-identity:${osChain}:${contractAddress.toLowerCase()}`;
  const slug = await getOrRefresh<string | null>(
    identKey,
    { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000 },
    async () => {
      const ident = await fetch(`https://api.opensea.io/api/v2/chain/${osChain}/contract/${contractAddress}`, {
        headers: { "x-api-key": openSeaApiKey, accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      if (!ident.ok) throw new Error(`opensea identity HTTP ${ident.status}`);
      return ((await ident.json()) as { collection?: string }).collection ?? null;
    }
  ).catch(() => null);
  if (!slug) return filled;

  const osHeaders = { "x-api-key": openSeaApiKey, accept: "application/json" };
  type OpenSeaCollectionStats = {
    total?: { num_owners?: number; floor_price?: number; listed_count?: number };
    intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
  };
  const stats = await getOrRefresh<OpenSeaCollectionStats | null>(
    `opensea-collection-stats:${osChain}:${slug}`,
    { softTtlMs: 60_000, hardTtlMs: 10 * 60_000 },
    async () => {
      const statsRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
        headers: osHeaders,
        signal: AbortSignal.timeout(12_000),
      });
      if (!statsRes.ok) throw new Error(`opensea collection stats HTTP ${statsRes.status}`);
      return (await statsRes.json()) as OpenSeaCollectionStats;
    }
  ).catch(() => null);
  if (stats) {
    const oneDay = stats.intervals?.find((i) => i.interval === "one_day");
    const sevenDay = stats.intervals?.find((i) => i.interval === "seven_day");
    const thirtyDay = stats.intervals?.find((i) => i.interval === "thirty_day");
    if (oneDay || sevenDay || thirtyDay) {
      await updateCollectionMarketStats(chainSlug, contractAddress, {
        volume24hWei: nativeToWei(oneDay?.volume),
        sales24h: oneDay?.sales ?? null,
        volume7dWei: nativeToWei(sevenDay?.volume),
        sales7d: sevenDay?.sales ?? null,
        volume30dWei: nativeToWei(thirtyDay?.volume),
        sales30d: thirtyDay?.sales ?? null,
        currentFloorPriceWei: null,
      }).catch(() => {});
      filled = true;
    }
    if (typeof stats.total?.num_owners === "number" && stats.total.num_owners > 0) {
      await updateHolderCount(chainSlug, contractAddress, stats.total.num_owners).catch(() => {});
      filled = true;
    }
    const floorWei = nativeToWei(stats.total?.floor_price);
    if (floorWei) {
      const currency = foreignChainByChainSlug(chainSlug)?.nativeCurrencySymbol ?? "ETH";
      await updateCollectionFloorOnly(chainSlug, contractAddress, {
        floorPriceWei: floorWei,
        floorPriceCurrency: currency,
        floorPriceMarketplace: "opensea",
      }).catch(() => {});
      filled = true;
    }
    if (typeof stats.total?.listed_count === "number") {
      // Never let OpenSea's generic count clobber CryptoPunks' real
      // contract-state count above -- see isCryptoPunks's own comment.
      if (!isCryptoPunks(chainSlug, contractAddress)) {
        await updateCollectionSupplyFields(chainSlug, contractAddress, {
          listedCount: stats.total.listed_count,
          totalSupply: null,
        }).catch(() => {});
      }
      filled = true;
    } else if (!isCryptoPunks(chainSlug, contractAddress)) {
      // Some real, high-volume collections (confirmed live: Courtyard.io on
      // Polygon, 400k+ supply / 2.5M+ lifetime sales) simply omit
      // `total.listed_count` from this endpoint's response entirely --
      // there is no missing/zero value to distrust, the field is absent.
      // Fall back to OpenSea's own real order book: a bounded page walk of
      // the SAME /listings/collection/{slug}/all endpoint listings/route.ts
      // already uses to render this collection's actual cards, so the
      // count is real live orders, never fabricated. A truncated walk still
      // yields a true lower bound (never an inflated number), which is
      // enough for gradeScore()'s "is there a live book at all" check even
      // when the full count isn't captured.
      const page = await fetchAllOpenSeaListings(slug, { apiKeyOverride: openSeaApiKey, maxListings: 500, pageSize: 100 }).catch(() => null);
      if (page && page.listings.length > 0) {
        const distinctTokens = new Set(
          page.listings
            .map((l) => l.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria)
            .filter((id): id is string => Boolean(id))
        );
        if (distinctTokens.size > 0) {
          await updateCollectionSupplyFields(chainSlug, contractAddress, {
            listedCount: distinctTokens.size,
            totalSupply: null,
          }).catch(() => {});
          filled = true;
        }
      }
    }
  }

  type OpenSeaCollectionMeta = { name?: string; image_url?: string; total_supply?: number | null };
  // Same key namespace listings/route.ts's collectionMeta fetch uses --
  // both resolve the identical OpenSea /collections/{slug} identity/name/
  // image payload for the same collection, keyed on the same resolved slug,
  // so a page view and a hub hydrate call share one cache entry instead of
  // each maintaining an independent (and independently uncoalesced) copy.
  const meta = await getOrRefresh<OpenSeaCollectionMeta | null>(
    `opensea-collection-meta:${osChain}:${slug}`,
    { softTtlMs: 5 * 60_000, hardTtlMs: 60 * 60_000 },
    async () => {
      const metaRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
        headers: osHeaders,
        signal: AbortSignal.timeout(12_000),
      });
      if (!metaRes.ok) throw new Error(`opensea collection meta HTTP ${metaRes.status}`);
      return (await metaRes.json()) as OpenSeaCollectionMeta;
    }
  ).catch(() => null);
  if (meta) {
    if (meta.name || meta.image_url) {
      await updateCollectionDisplay(chainSlug, contractAddress, {
        name: meta.name ?? null,
        imageUrl: meta.image_url ?? null,
      }).catch(() => {});
    }
    if (typeof meta.total_supply === "number" && meta.total_supply > 0) {
      await updateCollectionSupplyFields(chainSlug, contractAddress, {
        listedCount: null,
        totalSupply: meta.total_supply,
      }).catch(() => {});
    }
  }
  return filled;
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-hydrate-stats", limit: 8, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as {
    chainSlug?: string;
    contracts?: string[];
    rows?: Array<{ chainSlug?: string; contractAddress?: string }>;
  } | null;
  const fromRows = (body?.rows ?? [])
    .filter((r) => r && typeof r.chainSlug === "string" && typeof r.contractAddress === "string" && r.contractAddress.length > 8)
    .map((r) => ({ chainSlug: r.chainSlug as string, contractAddress: r.contractAddress as string }));
  const fromLegacy = (body?.chainSlug && Array.isArray(body.contracts) ? body.contracts : [])
    .filter((a) => typeof a === "string" && a.length > 8)
    .map((contractAddress) => ({ chainSlug: body!.chainSlug as string, contractAddress }));
  const seen = new Set<string>();
  const jobs = [...fromRows, ...fromLegacy].filter((j) => {
    const k = `${j.chainSlug}:${j.contractAddress}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 10);
  if (jobs.length === 0) {
    return NextResponse.json({ error: "rows[] or chainSlug+contracts[] required" }, { status: 400 });
  }

  try {
    let ok = 0;
    for (const job of jobs) {
      if (await refreshOne(job.chainSlug, job.contractAddress)) ok += 1;
    }
    return NextResponse.json({ hydrated: ok, attempted: jobs.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to hydrate collection stats");
  }
}
