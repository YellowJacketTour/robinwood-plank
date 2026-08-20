/**
 * Bounded OpenSea /stats + collection meta refresh for hub ranking cells.
 * Never fabricates volume/sales/floor. One contract at a time; callers cap fan-out.
 */
import { foreignChainByChainSlug } from "@/lib/market/multichain/trading/foreign-chain-registry";
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { updateCollectionMarketStats, updateCollectionSupplyFields, updateCollectionDisplay } from "@/lib/market/multichain/store";

function openSeaChainFor(chainSlug: string): string | null {
  if (chainSlug === "robinhood") return "robinhood";
  return foreignChainByChainSlug(chainSlug)?.openSeaChain ?? null;
}

export async function refreshOpenSeaStatsForContract(
  chainSlug: string,
  contractAddress: string
): Promise<{ ok: boolean; slug?: string }> {
  const osChain = openSeaChainFor(chainSlug);
  if (!osChain) return { ok: false };
  const key = await getOpenSeaApiKey();
  if (!key) return { ok: false };

  const ident = await fetch(`https://api.opensea.io/api/v2/chain/${osChain}/contract/${contractAddress}`, {
    headers: { "x-api-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!ident.ok) return { ok: false };
  const identJson = (await ident.json()) as { collection?: string };
  const slug = identJson.collection;
  if (!slug) return { ok: false };

  const metaRes = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}`, {
    headers: { "x-api-key": key, accept: "application/json" },
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
    headers: { "x-api-key": key, accept: "application/json" },
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
  const toWei = (v: number | undefined) => (typeof v === "number" ? BigInt(Math.round(v * 1e18)).toString() : null);

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

  return { ok: true, slug };
}
