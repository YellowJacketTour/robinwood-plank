import { chainManifest } from "@/lib/market/multichain/chains/manifest";
import type { ParityInput } from "./parity";

/**
 * Independent references, read keylessly wherever the source allows it.
 *
 * - CoinGecko NFT (all families: EVM by platform+contract, Solana and
 *   Bitcoin Ordinals by CoinGecko id). Public API without a key is
 *   rate-limited but real; a Demo key (free) raises the limit and is used
 *   when present. Returns floor, 24h volume, 24h sales, supply, holders.
 * - Magic Eden Solana stats: keyless per-symbol floor / listed / volume.
 * - Hiro Ordinals API: keyless global inscription count for coverage
 *   parity (how much of "all ordinals" the archive holds).
 *
 * Deliberately not here: Dune (needs a query id per metric in the owner's
 * account; wire as a fourth reference when a DUNE_API_KEY exists), Tensor
 * (keyed), Magic Eden Ordinals (Cloudflare 403 from servers).
 */
export type Reference = { source: "coingecko" | "magiceden" | "hiro"; values: ParityInput; fetchedAt: string; note?: string };

const CG = "https://api.coingecko.com/api/v3";

function cgHeaders(): Record<string, string> {
  const key = process.env.COINGECKO_API_KEY?.trim();
  return key ? { accept: "application/json", "x-cg-demo-api-key": key } : { accept: "application/json" };
}

async function getJson<T>(url: string, headers: Record<string, string> = { accept: "application/json" }, timeoutMs = 12_000): Promise<T | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as T | null;
}

type CgNft = {
  total_supply?: number | null;
  floor_price?: { native_currency?: number | null } | null;
  volume_24h?: { native_currency?: number | null } | null;
  one_day_sales?: number | null;
  number_of_unique_addresses?: number | null;
};

export async function readCoinGeckoReference(input: { chainSlug: string; contractAddress: string; coingeckoId?: string | null }): Promise<Reference | null> {
  const platform = chainManifest(input.chainSlug)?.coingeckoPlatform ?? null;
  const url = input.coingeckoId
    ? `${CG}/nfts/${encodeURIComponent(input.coingeckoId)}`
    : platform
      ? `${CG}/nfts/${encodeURIComponent(platform)}/contract/${encodeURIComponent(input.contractAddress)}`
      : null;
  if (!url) return null;
  const body = await getJson<CgNft>(url, cgHeaders());
  if (!body) return null;
  return {
    source: "coingecko",
    fetchedAt: new Date().toISOString(),
    values: {
      floor: body.floor_price?.native_currency ?? null,
      volume24h: body.volume_24h?.native_currency ?? null,
      sales24h: body.one_day_sales ?? null,
      supply: body.total_supply ?? null,
    },
  };
}

type MeStats = { floorPrice?: number | null; listedCount?: number | null; volume24hr?: number | null; volumeAll?: number | null };

export async function readMagicEdenReference(symbol: string): Promise<Reference | null> {
  const body = await getJson<MeStats>(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/stats`);
  if (!body) return null;
  return {
    source: "magiceden",
    fetchedAt: new Date().toISOString(),
    values: {
      floor: body.floorPrice != null ? body.floorPrice / 1e9 : null,
      listed: body.listedCount ?? null,
      volume24h: body.volume24hr != null ? body.volume24hr / 1e9 : null,
    },
  };
}

/** Global inscription count from Hiro: the denominator of "all ordinals". */
export async function readHiroInscriptionTotal(): Promise<number | null> {
  const body = await getJson<{ total?: number }>("https://api.hiro.so/ordinals/v1/inscriptions?limit=1");
  return body?.total ?? null;
}
