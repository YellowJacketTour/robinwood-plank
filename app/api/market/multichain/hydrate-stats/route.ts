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

async function refreshOne(chainSlug: string, contractAddress: string): Promise<boolean> {
  if (isSolanaChainSlug(chainSlug)) {
    const me = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(contractAddress)}/stats`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    }).catch(() => null);
    if (!me?.ok) return false;
    const stats = (await me.json()) as { listedCount?: number; uniqueHolders?: number; floorPrice?: number | null };
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

  const ident = await fetch(`https://api.opensea.io/api/v2/chain/${osChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": openSeaApiKey, accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (!ident?.ok) return filled;
  const slug = ((await ident.json()) as { collection?: string }).collection;
  if (!slug) return filled;

  const osHeaders = { "x-api-key": openSeaApiKey, accept: "application/json" };
  const statsRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (statsRes?.ok) {
    const stats = (await statsRes.json()) as {
      total?: { num_owners?: number; floor_price?: number; listed_count?: number };
      intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
    };
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
      await updateCollectionSupplyFields(chainSlug, contractAddress, {
        listedCount: stats.total.listed_count,
        totalSupply: null,
      }).catch(() => {});
      filled = true;
    }
  }

  const metaRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(12_000),
  }).catch(() => null);
  if (metaRes?.ok) {
    const meta = (await metaRes.json()) as {
      name?: string;
      image_url?: string;
      total_supply?: number | null;
    };
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
