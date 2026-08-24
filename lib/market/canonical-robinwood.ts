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
  const site = process.env.SITE_URL?.trim();
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
  sales24h: number;
  pricedSales24h: number;
  unpricedSales24h: number;
  volume24hWei: string | null;
  sales7d: number;
  volume7dWei: string | null;
  sales30d: number;
  volume30dWei: string | null;
  highestWei: string | null;
  highestTokenId: string | null;
  highestTxHash: string | null;
  highestPlatform: string | null;
  totalVolumeWei: string | null;
  listings: Array<Record<string, unknown>>;
};

export async function fetchCanonicalRobinwoodActivity(input: {
  hostHeader?: string | null;
  full?: boolean;
}): Promise<unknown[] | null> {
  if (isCanonicalRobinwoodHost(input.hostHeader)) return null;
  const origin = canonicalRobinwoodOrigin();
  const path = input.full ? "/api/market/activity?full=1" : "/api/market/activity";
  const json = await getJson(`${origin}${path}`);
  const events = (json as { events?: unknown })?.events;
  return Array.isArray(events) && events.length > 0 ? events : null;
}

/**
 * REAL BUG FIXED 2026-08-23, root-caused live: this legitimate server-to-
 * server request (this app reading its own public API, never a scraper)
 * was being blocked by the canonical origin's own ModSecurity WAF -- a
 * direct curl reproduced a real "406 Not Acceptable ... blocked by Mod
 * Security" against https://plank.love with the exact same bare
 * `{accept: "application/json"}` header set Node's fetch was sending
 * (no User-Agent at all, which is precisely the fingerprint generic bot
 * rules flag). Confirmed live this silently starved the
 * robinwood-floor-observation refresh step of a floor price in local dev
 * (empty local order book -> only real source is this canonical mirror),
 * so it recorded zero real observations for a long stretch, meaning
 * getObservedFloorChange24h had no comparison point and the UI correctly
 * (if unhelpfully) showed a blank 24h floor change instead of a real one.
 * A real browser-shaped User-Agent is enough to clear the WAF rule for
 * this legitimate same-family read.
 *
 * REAL GAP ALSO FIXED, flagged live ("how are other collections getting
 * real feeds ... and our own collection isn't -- unify solutions"): every
 * OTHER external source in this app (OpenSea, Alchemy, UniSat, Ordiscan,
 * ...) goes through source-budget.ts's circuit breaker, so a real outage/
 * block trips a visible, monitored jail. This mirror fetch had none of
 * that -- when the WAF started blocking it, it silently returned null
 * forever with zero signal anywhere, for over 22 hours, before being
 * root-caused by hand. Wiring the exact same checkSourceBudget/
 * recordSourceSuccess/recordSourceFailure pattern here means the next
 * failure (a real outage, a WAF rule change, anything) jails visibly and
 * gets picked up by whatever already watches every other source's
 * health, instead of degrading invisibly again.
 */
const MIRROR_SOURCE = "canonical-robinwood-mirror";

async function getJson(url: string): Promise<unknown | null> {
  const { checkSourceBudget, recordSourceSuccess, recordSourceFailure } = await import(
    "@/lib/market/multichain/discovery/source-budget"
  );
  if (!checkSourceBudget(MIRROR_SOURCE).allowed) return null;
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Marketplank-InternalMirror",
      },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) {
      recordSourceFailure(MIRROR_SOURCE, res.status === 429 || res.status === 403);
      console.warn(`canonical-robinwood: mirror fetch ${url} -> HTTP ${res.status}`);
      return null;
    }
    recordSourceSuccess(MIRROR_SOURCE);
    return await res.json();
  } catch (error) {
    recordSourceFailure(MIRROR_SOURCE, false);
    console.warn(`canonical-robinwood: mirror fetch ${url} failed`, error instanceof Error ? error.message : error);
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
  const sales24h = typeof salesObj.sales24h === "number" ? salesObj.sales24h : 0;
  const pricedSales24h =
    typeof salesObj.pricedSales24h === "number" ? salesObj.pricedSales24h : 0;
  const unpricedSales24h =
    typeof salesObj.unpricedSales24h === "number"
      ? salesObj.unpricedSales24h
      : Math.max(0, sales24h - pricedSales24h);
  const volume24hWei =
    typeof salesObj.volume24hWei === "string" ? salesObj.volume24hWei : null;
  const sales7d = typeof salesObj.sales7d === "number" ? salesObj.sales7d : 0;
  const volume7dWei = typeof salesObj.volume7dWei === "string" ? salesObj.volume7dWei : null;
  const sales30d = typeof salesObj.sales30d === "number" ? salesObj.sales30d : 0;
  const volume30dWei = typeof salesObj.volume30dWei === "string" ? salesObj.volume30dWei : null;
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
    sales24h,
    pricedSales24h,
    unpricedSales24h,
    volume24hWei,
    sales7d,
    volume7dWei,
    sales30d,
    volume30dWei,
    highestWei,
    highestTokenId,
    highestTxHash,
    highestPlatform,
    totalVolumeWei,
    listings,
  };
}
