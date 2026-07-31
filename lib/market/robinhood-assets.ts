import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import { CHAIN } from "@/lib/constants";

/**
 * Robinhood's own registry of the tokens it deploys on Robinhood Chain.
 *
 * Why this exists: token search runs against Blockscout's whole-chain ERC-20
 * index, which is the right breadth but has no authority behind it. Searching
 * "usdc" returns 50 tokens all called USDC, none price-tracked, none carrying a
 * verification flag, separated only by holder counts of 185 / 175 / 173. Ranking
 * by that is a coin flip presented as an answer, and in a swap picker the cost
 * of picking wrong is the user's money.
 *
 * This endpoint is the issuer speaking for itself: 96 assets, every one
 * deployed on chain 4663, with checksummed addresses. Where it has an opinion,
 * it settles the question outright. Where it does not — USDC is not in it —
 * we say so rather than dress up a guess.
 */

const ASSETS_URL = "https://api.robinhood.com/rhj/assets";
/** No TTL: last-known-good beats empty, and the cron refreshes it. */
const ASSETS_KV = "plank:market:robinhood-assets-v1";
const ACTIVE = "ASSET_STATUS_ACTIVE";

export type OfficialAsset = {
  /** Lowercased contract address on chain 4663. */
  address: string;
  symbol: string;
  name: string;
  logoUrl?: string;
};

type RawAsset = {
  tokenSymbol?: string;
  tokenName?: string;
  logoUrl?: string;
  status?: string;
  deployments?: Array<{ contractAddress?: string; chainId?: number | string }>;
};

export async function readOfficialAssets(): Promise<OfficialAsset[]> {
  if (!hasDurableKv()) return [];
  try {
    return (await kv.get<OfficialAsset[]>(ASSETS_KV)) ?? [];
  } catch {
    return [];
  }
}

export function officialAssetMap(assets: OfficialAsset[]): Map<string, OfficialAsset> {
  return new Map(assets.map((a) => [a.address, a]));
}

export function parseOfficialAssets(raw: unknown): OfficialAsset[] {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { results?: RawAsset[]; assets?: RawAsset[] })?.results ??
      (raw as { assets?: RawAsset[] })?.assets ??
      []);
  const out: OfficialAsset[] = [];
  for (const a of list as RawAsset[]) {
    // A delisted or suspended asset is not something to badge as official.
    if (a?.status && a.status !== ACTIVE) continue;
    for (const dep of a?.deployments ?? []) {
      if (String(dep?.chainId) !== String(CHAIN.id)) continue;
      const addr = dep?.contractAddress;
      if (typeof addr !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;
      out.push({
        address: addr.toLowerCase(),
        symbol: (a.tokenSymbol || "").trim(),
        name: (a.tokenName || a.tokenSymbol || "").trim(),
        ...(typeof a.logoUrl === "string" && /^https:\/\//.test(a.logoUrl)
          ? { logoUrl: a.logoUrl }
          : {}),
      });
    }
  }
  return out;
}

/**
 * Refresh the registry. Keeps the previous copy on any failure — losing the
 * official list would silently downgrade every badged token to "unverified",
 * which is worse than serving a slightly stale list.
 */
export async function refreshOfficialAssets(): Promise<OfficialAsset[]> {
  try {
    const res = await fetch(ASSETS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) return readOfficialAssets();
    const parsed = parseOfficialAssets(await res.json());
    if (parsed.length === 0) return readOfficialAssets();
    if (hasDurableKv()) {
      try {
        await kv.set(ASSETS_KV, parsed);
      } catch {
        /* next run retries */
      }
    }
    return parsed;
  } catch {
    return readOfficialAssets();
  }
}
