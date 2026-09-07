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

export type RefFailure = { source: string; status: number | "network"; at: string };
const failures: RefFailure[] = [];
/** Reference read failures since the last drain (429s are the common one). */
export function drainReferenceFailures(): RefFailure[] {
  return failures.splice(0, failures.length);
}

async function getJson<T>(url: string, headers: Record<string, string> = { accept: "application/json" }, timeoutMs = 12_000, source = "ref"): Promise<T | null> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res) {
    failures.push({ source, status: "network", at: new Date().toISOString() });
    return null;
  }
  if (!res.ok) {
    if (res.status !== 404) failures.push({ source, status: res.status, at: new Date().toISOString() });
    return null;
  }
  return (await res.json().catch(() => null)) as T | null;
}

/**
 * CoinGecko's public (keyless) API allows roughly 10 calls a minute from one
 * address; the first parity pass fired 200 in a quarter second and got
 * nothing back. One call every 6.5 s keeps the whole mesh under that line;
 * a free Demo key doubles it and is honoured when present.
 */
let cgNextAt = 0;
async function paceCoinGecko(): Promise<void> {
  const gapMs = process.env.COINGECKO_API_KEY?.trim() ? 2_200 : 6_500;
  const wait = cgNextAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  cgNextAt = Date.now() + gapMs;
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
  await paceCoinGecko();
  const body = await getJson<CgNft>(url, cgHeaders(), 12_000, "coingecko");
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
  const body = await getJson<MeStats>(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}/stats`, { accept: "application/json" }, 12_000, "magiceden");
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

/**
 * The denominator of "all ordinals", from ord itself. Hiro's Ordinals API
 * returned 410 Gone on 2026-09-07 (deprecated). ordinals.com runs the
 * reference `ord` server: its HTML index lists the newest inscriptions and
 * its recursive JSON endpoint /r/inscription/{id} returns that
 * inscription's number, which is the count of inscriptions ever made.
 * Two keyless calls; verified live: number 127,330,110 at height 965,969.
 */
export async function readOrdInscriptionTotal(): Promise<number | null> {
  const html = await fetch("https://ordinals.com/inscriptions", { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 plank.love parity" }, signal: AbortSignal.timeout(12_000) })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
  if (!html) {
    failures.push({ source: "ordinals.com", status: "network", at: new Date().toISOString() });
    return null;
  }
  const m = /\/inscription\/([0-9a-f]{64}i\d+)/.exec(html);
  if (!m) return null;
  const body = await getJson<{ number?: number }>(`https://ordinals.com/r/inscription/${m[1]}`, { accept: "application/json" }, 12_000, "ordinals.com");
  return typeof body?.number === "number" ? body.number + 1 : null;
}

/** @deprecated Hiro's API is gone; kept as an alias so callers read one name. */
export const readHiroInscriptionTotal = readOrdInscriptionTotal;
