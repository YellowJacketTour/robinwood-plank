/**
 * When this process's Postgres book/ledger is empty (local `dev`), native
 * RobinWood stats still have a public source: the live Marketplank origin.
 * That is plank.love's own GET APIs — same collection, exact public JSON —
 * not a fabricated floor.
 *
 * Never persist canonical `rawOrder` payloads here (signatures already sit
 * on the public live API). Never call this when we ARE the canonical host
 * (self-fetch loop). Never log order bodies.
 */
export const CANONICAL_ROBINWOOD_ORIGIN_DEFAULT = "https://plank.love";

export function canonicalRobinwoodOrigin(): string {
  const raw = process.env.ROBINWOOD_CANONICAL_ORIGIN?.trim() || CANONICAL_ROBINWOOD_ORIGIN_DEFAULT;
  return raw.replace(/\/$/, "");
}

export function isCanonicalRobinwoodHost(hostHeader: string | null | undefined): boolean {
  const canonHost = hostOf(canonicalRobinwoodOrigin());
  if (!canonHost) return false;
  const incoming = (hostHeader ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (incoming && incoming === canonHost) return true;
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site && hostOf(site) === canonHost) return true;
  return false;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export type CanonicalRobinwoodStats = {
  source: "canonical-live";
  origin: string;
  floorPriceWei: string | null;
  listedCount: number;
  saleCount: number;
  highestWei: string | null;
  highestTokenId: string | null;
  highestTxHash: string | null;
  highestPlatform: string | null;
  totalVolumeWei: string | null;
  listings: Array<Record<string, unknown>>;
};

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function minPriceWei(items: Array<{ priceWei?: unknown }>): string | null {
  let min: bigint | null = null;
  for (const item of items) {
    if (typeof item.priceWei !== "string" || !/^\d+$/.test(item.priceWei)) continue;
    try {
      const p = BigInt(item.priceWei);
      if (p > 0n && (min == null || p < min)) min = p;
    } catch {
      /* skip */
    }
  }
  return min != null ? min.toString() : null;
}

export async function fetchCanonicalRobinwoodStats(input: {
  hostHeader?: string | null;
}): Promise<CanonicalRobinwoodStats | null> {
  if (isCanonicalRobinwoodHost(input.hostHeader)) return null;
  const origin = canonicalRobinwoodOrigin();
  const [orders, sales] = await Promise.all([
    getJson(`${origin}/api/market/orders?collection=robinwood&kind=listing`),
    getJson(`${origin}/api/market/sales-stats`),
  ]);
  const listings = Array.isArray((orders as { items?: unknown })?.items)
    ? ((orders as { items: Array<Record<string, unknown>> }).items)
    : [];
  const salesObj = sales && typeof sales === "object" ? (sales as Record<string, unknown>) : {};
  const saleCount = typeof salesObj.saleCount === "number" ? salesObj.saleCount : 0;
  const highestWei = typeof salesObj.highestWei === "string" ? salesObj.highestWei : null;
  const highestTokenId = typeof salesObj.highestTokenId === "string" ? salesObj.highestTokenId : null;
  const highestTxHash = typeof salesObj.highestTxHash === "string" ? salesObj.highestTxHash : null;
  const highestPlatform = typeof salesObj.highestPlatform === "string" ? salesObj.highestPlatform : null;
  const totalVolumeWei = typeof salesObj.totalVolumeWei === "string" ? salesObj.totalVolumeWei : null;
  if (listings.length === 0 && saleCount === 0) return null;
  return {
    source: "canonical-live",
    origin,
    floorPriceWei: minPriceWei(listings),
    listedCount: listings.length,
    saleCount,
    highestWei,
    highestTokenId,
    highestTxHash,
    highestPlatform,
    totalVolumeWei,
    listings,
  };
}
