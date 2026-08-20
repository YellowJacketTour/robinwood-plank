/**
 * Bounded OpenSea /stats + collection meta refresh for hub ranking cells.
 * Never fabricates volume/sales/floor. One contract at a time; callers cap fan-out.
 * af1fc7f: OpenSea credential is `openSeaApiKey` only — never a second `const key`.
 */
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import {
  updateCollectionMarketStats,
  updateCollectionSupplyFields,
  updateCollectionDisplay,
  updateHolderCount,
} from "@/lib/market/multichain/store";
import { isSolanaChainSlug } from "@/lib/market/multichain/trading/non-evm-chains";

function openSeaChainFor(chainSlug: string): string | null {
  if (chainSlug === "robinhood") return "robinhood";
  return foreignChainByChainSlug(chainSlug)?.openSeaChain ?? null;
}

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

async function refreshCoinGeckoByContract(chainSlug: string, contractAddress: string): Promise<boolean> {
  const platform = CG_PLATFORM[chainSlug];
  if (!platform) return false;
  const cgDemoKey = process.env.COINGECKO_API_KEY?.trim();
  const headers: Record<string, string> = cgDemoKey
    ? { accept: "application/json", "x-cg-demo-api-key": cgDemoKey }
    : { accept: "application/json" };
  const res = await fetch(
    `https://api.coingecko.com/api/v3/nfts/${platform}/contract/${encodeURIComponent(contractAddress)}`,
    { headers, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) return false;
  const d = (await res.json()) as {
    volume_24h?: { native_currency?: number };
    one_day_sales?: number;
    floor_price_24h_percentage_change?: { native_currency?: number };
    number_of_unique_addresses?: number;
    total_supply?: number;
  };
  const volume24hWei = toWei(d.volume_24h?.native_currency);
  const sales24h = typeof d.one_day_sales === "number" ? d.one_day_sales : null;
  const change = d.floor_price_24h_percentage_change?.native_currency;
  await updateCollectionMarketStats(chainSlug, contractAddress, {
    volume24hWei,
    sales24h,
    currentFloorPriceWei: null,
    floorChangePct: typeof change === "number" && Number.isFinite(change) ? change : null,
  }).catch(() => {});
  if (typeof d.number_of_unique_addresses === "number" && d.number_of_unique_addresses > 0) {
    await updateHolderCount(chainSlug, contractAddress, d.number_of_unique_addresses).catch(() => {});
  }
  if (typeof d.total_supply === "number" && d.total_supply > 0) {
    await updateCollectionSupplyFields(chainSlug, contractAddress, { listedCount: null, totalSupply: d.total_supply }).catch(() => {});
  }
  return volume24hWei != null || sales24h != null;
}

async function refreshMagicEdenSolana(symbol: string): Promise<boolean> {
  const res = await fetch(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/stats`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return false;
  const stats = (await res.json()) as { listedCount?: number; floorPrice?: number; uniqueHolders?: number };
  if (typeof stats.listedCount === "number") {
    await updateCollectionSupplyFields("solana-mainnet", symbol, {
      listedCount: stats.listedCount,
      totalSupply: null,
    }).catch(() => {});
  }
  if (typeof stats.uniqueHolders === "number" && stats.uniqueHolders > 0) {
    await updateHolderCount("solana-mainnet", symbol, stats.uniqueHolders).catch(() => {});
  }
  return true;
}

export async function refreshOpenSeaStatsForContract(
  chainSlug: string,
  contractAddress: string
): Promise<{ ok: boolean; slug?: string }> {
  if (isSolanaChainSlug(chainSlug)) {
    const ok = await refreshMagicEdenSolana(contractAddress);
    const cg = await refreshCoinGeckoByContract(chainSlug, contractAddress).catch(() => false);
    return { ok: ok || cg };
  }

  const cgFirst = await refreshCoinGeckoByContract(chainSlug, contractAddress).catch(() => false);

  const osChain = openSeaChainFor(chainSlug);
  if (!osChain) return { ok: cgFirst };
  const openSeaApiKey = await getOpenSeaApiKey();
  if (!openSeaApiKey) return { ok: cgFirst };

  const ident = await fetch(`https://api.opensea.io/api/v2/chain/${osChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": openSeaApiKey, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!ident.ok) return { ok: cgFirst };
  const identJson = (await ident.json()) as { collection?: string };
  const slug = identJson.collection;
  if (!slug) return { ok: cgFirst };

  const osHeaders = { "x-api-key": openSeaApiKey, accept: "application/json" };
  const metaRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(15_000),
  });
  const meta = metaRes.ok
    ? ((await metaRes.json()) as {
        name?: string;
        image_url?: string;
        total_supply?: number | null;
        twitter_username?: string | null;
        owner?: string | null;
      })
    : null;

  if (meta?.name || meta?.image_url) {
    await updateCollectionDisplay(chainSlug, contractAddress, {
      name: meta.name ?? null,
      imageUrl: meta.image_url ?? null,
      creatorHandle: meta.twitter_username ?? null,
      creatorAddress: meta.owner ?? null,
      creatorEns: null,
    }).catch(() => {});
  }
  if (typeof meta?.total_supply === "number" && meta.total_supply > 0) {
    await updateCollectionSupplyFields(chainSlug, contractAddress, {
      listedCount: null,
      totalSupply: meta.total_supply,
    }).catch(() => {});
  }

  const stats = (await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
    headers: osHeaders,
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as {
    total?: { volume?: number; sales?: number; num_owners?: number };
    intervals?: Array<{ interval: string; volume?: number; sales?: number }>;
  } | null;

  const oneDay = stats?.intervals?.find((i) => i.interval === "one_day");
  const sevenDay = stats?.intervals?.find((i) => i.interval === "seven_day");
  const thirtyDay = stats?.intervals?.find((i) => i.interval === "thirty_day");
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
  if (typeof stats?.total?.num_owners === "number" && stats.total.num_owners > 0) {
    await updateHolderCount(chainSlug, contractAddress, stats.total.num_owners).catch(() => {});
  }

  return { ok: true, slug };
}
