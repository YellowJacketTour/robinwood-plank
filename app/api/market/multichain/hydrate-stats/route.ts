/**
 * Fills hub ranking cells for a bounded set of visible contracts.
 * OpenSea credential is openSeaApiKey only. Fail closed. No Alchemy.
 */
import { NextRequest, NextResponse } from "next/server";
import { publicError, rateLimit } from "@/lib/security";
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import {
  updateCollectionMarketStats,
  updateCollectionSupplyFields,
  updateCollectionDisplay,
  updateHolderCount,
} from "@/lib/market/multichain/store";
import { isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

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

function toWei(v: number | undefined): string | null {
  return typeof v === "number" && Number.isFinite(v) ? BigInt(Math.round(v * 1e18)).toString() : null;
}

async function refreshOne(chainSlug: string, contractAddress: string): Promise<boolean> {
  if (isSolanaChainSlug(chainSlug)) {
    const me = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(contractAddress)}/stats`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (me?.ok) {
      const stats = (await me.json()) as { listedCount?: number; uniqueHolders?: number };
      if (typeof stats.listedCount === "number") {
        await updateCollectionSupplyFields("solana-mainnet", contractAddress, { listedCount: stats.listedCount, totalSupply: null }).catch(() => {});
      }
      if (typeof stats.uniqueHolders === "number" && stats.uniqueHolders > 0) {
        await updateHolderCount("solana-mainnet", contractAddress, stats.uniqueHolders).catch(() => {});
      }
      return true;
    }
    return false;
  }

  const platform = CG_PLATFORM[chainSlug];
  let cgOk = false;
  if (platform) {
    const cgDemo = process.env.COINGECKO_API_KEY?.trim();
    const cgHeaders: Record<string, string> = cgDemo
      ? { accept: "application/json", "x-cg-demo-api-key": cgDemo }
      : { accept: "application/json" };
    const cg = await fetch(
      `https://api.coingecko.com/api/v3/nfts/${platform}/contract/${encodeURIComponent(contractAddress)}`,
      { headers: cgHeaders, signal: AbortSignal.timeout(15_000) }
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
        volume24hWei: toWei(d.volume_24h?.native_currency),
        sales24h: typeof d.one_day_sales === "number" ? d.one_day_sales : null,
        currentFloorPriceWei: null,
        floorChangePct:
          typeof d.floor_price_24h_percentage_change?.native_currency === "number"
            ? d.floor_price_24h_percentage_change.native_currency
            : null,
      }).catch(() => {});
      if (typeof d.number_of_unique_addresses === "number" && d.number_of_unique_addresses > 0) {
        await updateHolderCount(chainSlug, contractAddress, d.number_of_unique_addresses).catch(() => {});
      }
      cgOk = true;
    }
  }

  const osChain = chainSlug === "robinhood" ? "robinhood" : foreignChainByChainSlug(chainSlug)?.openSeaChain ?? null;
  const openSeaApiKey = osChain ? await getOpenSeaApiKey() : null;
  if (!osChain || !openSeaApiKey) return cgOk;

  const ident = await fetch(`https://api.opensea.io/api/v2/chain/${osChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": openSeaApiKey, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!ident?.ok) return cgOk;
  const slug = ((await ident.json()) as { collection?: string }).collection;
  if (!slug) return cgOk;

  const osHeaders = { "x-api-key": openSeaApiKey, accept: "application/json" };
  const metaRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (metaRes?.ok) {
    const meta = (await metaRes.json()) as {
      name?: string;
      image_url?: string;
      total_supply?: number | null;
      twitter_username?: string | null;
      owner?: string | null;
    };
    if (meta.name || meta.image_url) {
      await updateCollectionDisplay(chainSlug, contractAddress, {
        name: meta.name ?? null,
        imageUrl: meta.image_url ?? null,
        creatorHandle: meta.twitter_username ?? null,
        creatorAddress: meta.owner ?? null,
        creatorEns: null,
      }).catch(() => {});
    }
    if (typeof meta.total_supply === "number" && meta.total_supply > 0) {
      await updateCollectionSupplyFields(chainSlug, contractAddress, { listedCount: null, totalSupply: meta.total_supply }).catch(() => {});
    }
  }

  const statsRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (statsRes?.ok) {
    const stats = (await statsRes.json()) as {
      total?: { num_owners?: number };
      intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
    };
    const oneDay = stats.intervals?.find((i) => i.interval === "one_day");
    const sevenDay = stats.intervals?.find((i) => i.interval === "seven_day");
    const thirtyDay = stats.intervals?.find((i) => i.interval === "thirty_day");
    if (oneDay || sevenDay || thirtyDay) {
      await updateCollectionMarketStats(chainSlug, contractAddress, {
        volume24hWei: toWei(oneDay?.volume),
        sales24h: oneDay?.sales ?? null,
        volume7dWei: toWei(sevenDay?.volume),
        sales7d: sevenDay?.sales ?? null,
        volume30dWei: toWei(thirtyDay?.volume),
        sales30d: thirtyDay?.sales ?? null,
        currentFloorPriceWei: null,
      }).catch(() => {});
    }
    if (typeof stats.total?.num_owners === "number" && stats.total.num_owners > 0) {
      await updateHolderCount(chainSlug, contractAddress, stats.total.num_owners).catch(() => {});
    }
  }
  return true;
}

export async function POST(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-multichain-hydrate-stats", limit: 10, windowMs: 60_000 });
  if (limited) return limited;

  const body = (await req.json().catch(() => null)) as { chainSlug?: string; contracts?: string[] } | null;
  const chainSlug = body?.chainSlug;
  const contracts = [...new Set((body?.contracts ?? []).filter((a) => typeof a === "string" && a.length > 0))].slice(0, 8);
  if (!chainSlug || contracts.length === 0) {
    return NextResponse.json({ error: "chainSlug and contracts[] are required" }, { status: 400 });
  }

  try {
    let ok = 0;
    for (const address of contracts) {
      if (await refreshOne(chainSlug, address)) ok += 1;
    }
    return NextResponse.json({ hydrated: ok, attempted: contracts.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return publicError(error, "Failed to hydrate collection stats");
  }
}
