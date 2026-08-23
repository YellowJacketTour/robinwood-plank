/**
 * Per-token art for the rarity catalog. Collection-list NFT pages (ids 1..N)
 * do not match rarity-sorted ids (6770, 7254…). Resolve THIS page's token
 * ids. Exact contract templates (live-verified) first; OpenSea by id next.
 * Never invent; never replace a stored URL.
 */
import { getOpenSeaApiKey } from "@/lib/market/opensea";
import { checkSourceBudget, recordSourceSuccess, recordSourceFailure } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { OPENSEA_STATS_DAILY_ALLOWANCE, OPENSEA_STATS_PROVIDER_ACCOUNT } from "@/lib/market/multichain/discovery/opensea-stats";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";
export { templatedErc721Image } from "@/lib/market/multichain/token-art-templates";
import { templatedErc721Image } from "@/lib/market/multichain/token-art-templates";

export async function fetchOpenSeaTokenImage(
  openSeaChain: string,
  contractAddress: string,
  tokenId: string
): Promise<string | null> {
  const key = await getOpenSeaApiKey();
  if (!key) return null;
  if (!checkSourceBudget("opensea-stats").allowed) return null;
  // Same real OpenSea API key/quota pool opensea-stats.ts's own SOURCE
  // tracks -- reserving against that SAME shared provider account (not a
  // separate one) so this and opensea-stats.ts/opensea-bulk-scan.ts
  // together never exceed the one real rate limit.
  const window = utcDayWindow(OPENSEA_STATS_DAILY_ALLOWANCE);
  if (!(await reserveProviderCapacity(OPENSEA_STATS_PROVIDER_ACCOUNT, window))) return null;
  const chainPath = openSeaChain === "matic" ? "matic" : openSeaChain;
  const url = `https://api.opensea.io/api/v2/chain/${encodeURIComponent(chainPath)}/contract/${contractAddress}/nfts/${encodeURIComponent(tokenId)}`;
  let res: Response;
  let settled = false;
  try {
    res = await fetch(url, {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    await settleProviderCapacity(OPENSEA_STATS_PROVIDER_ACCOUNT, window, 1, true);
    settled = true;
  } catch (error) {
    if (!settled) await settleProviderCapacity(OPENSEA_STATS_PROVIDER_ACCOUNT, window, 1, true).catch(() => {});
    throw error;
  }
  if (!res.ok) {
    recordSourceFailure("opensea-stats", res.status === 429);
    return null;
  }
  recordSourceSuccess("opensea-stats");
  const body = (await res.json()) as { nft?: { image_url?: string | null; display_image_url?: string | null } };
  const raw = body.nft?.display_image_url || body.nft?.image_url || null;
  return preferHighestResImageUrl(raw) ?? raw;
}

/**
 * Fill missing images for the tokens on THIS browse page. Templates are
 * instant; OS-by-id is capped so one request cannot 429 the whole source.
 */
export async function resolveTokenImagesForPage(input: {
  openSeaChain: string | null;
  contractAddress: string | null;
  tokens: Array<{ tokenId: string; imageUrl: string | null }>;
  maxRemote?: number;
}): Promise<Array<{ tokenId: string; imageUrl: string }>> {
  const filled: Array<{ tokenId: string; imageUrl: string }> = [];
  const contract = input.contractAddress?.toLowerCase() ?? null;
  const pending = input.tokens.filter((t) => !t.imageUrl);
  for (const t of pending) {
    if (contract) {
      const templated = templatedErc721Image(contract, t.tokenId);
      if (templated) {
        t.imageUrl = templated;
        filled.push({ tokenId: t.tokenId, imageUrl: templated });
      }
    }
  }
  const still = pending.filter((t) => !t.imageUrl);
  const remote = still.slice(0, input.maxRemote ?? 24);
  if (!input.openSeaChain || !contract) return filled;
  const addr = input.contractAddress!;
  for (const t of remote) {
    const img = await fetchOpenSeaTokenImage(input.openSeaChain, addr, t.tokenId);
    if (!img) continue;
    t.imageUrl = img;
    filled.push({ tokenId: t.tokenId, imageUrl: img });
  }
  return filled;
}
