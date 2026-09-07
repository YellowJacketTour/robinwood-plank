/**
 * BestInSlot -- Bitcoin Ordinals collection stats + listings aggregator
 * (docs.bestinslot.xyz). Added 2026-09-06 (AUDIT Batch E4-bitcoin, research
 * lens R1 #4): Magic Eden's Bitcoin API was shut down 2026-03-27, so the
 * surviving read sources for Ordinals books are UniSat, OKX Onchain OS,
 * BestInSlot (which itself aggregates OrdSwap, ME, Ordinals Wallet, Gamma,
 * UniSat, OKX floors) and on-chain settlement.
 *
 * KEY-GATED: every BestInSlot v3 call needs `x-api-key: BESTINSLOT_API_KEY`.
 * Without it every reader here returns `state: "credential-missing"` and an
 * empty result -- never a scraped approximation, never a fabricated floor.
 *
 * Endpoints (BestInSlot v3, docs.bestinslot.xyz):
 *   GET /v3/collection/info?slug=<slug>            -- name/supply/floor/listed/volume/holders
 *   GET /v3/collection/listings?slug=<slug>&...    -- active listings (aggregated)
 * Response field names are taken from the docs but have not been driven
 * against a live key from this environment (no BESTINSLOT_API_KEY is
 * configured here), so the parsers accept the documented names first and a
 * small set of snake/camel variants second, and `verifyBestInSlotCredentials`
 * exists to confirm the shape the first time a real key is present. Nothing
 * here writes a floor unless a numeric value was actually present.
 */
import { postgresQuery, hasPostgresConfig } from "@/lib/postgres";

const BASE_URL = "https://api.bestinslot.xyz/v3";
const CHAIN_SLUG = "bitcoin-mainnet";
export const BESTINSLOT_MARKETPLACE = "bestinslot";

export type CredentialState = "credential-missing" | "queried" | "upstream-error" | "not-found";

export type BestInSlotCollectionStats = {
  slug: string;
  name: string | null;
  totalSupply: number | null;
  floorPriceSats: number | null;
  listedCount: number | null;
  holderCount: number | null;
  volume24hSats: number | null;
  sales24h: number | null;
};

export type BestInSlotListing = {
  inscriptionId: string;
  priceSats: number;
  sellerAddress: string | null;
  marketplace: string | null;
  inscriptionNumber: number | null;
};

export function bestInSlotCredentialState(): "credential-missing" | "ready" {
  return process.env.BESTINSLOT_API_KEY ? "ready" : "credential-missing";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return null;
}

/** Pure parser (unit-tested): documented names first, defensive variants second. Null when no real stats object is present. */
export function parseBestInSlotCollectionInfo(body: unknown, slug: string): BestInSlotCollectionStats | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  if (!data || typeof data !== "object") return null;
  const name = typeof pick(data, "name", "collection_name") === "string" ? (pick(data, "name", "collection_name") as string) : null;
  const totalSupply = num(pick(data, "supply", "total_supply", "totalSupply", "inscription_count"));
  const floorPriceSats = num(pick(data, "floor_price", "floorPrice", "floor_price_sats", "min_price"));
  const listedCount = num(pick(data, "listed_count", "listedCount", "listed"));
  const holderCount = num(pick(data, "holder_count", "holders", "unique_holders", "uniqueHolders"));
  const volume24hSats = num(pick(data, "volume_24h", "vol_24h", "volume24h"));
  const sales24h = num(pick(data, "sales_24h", "sale_count_24h", "sales24h"));
  if (name == null && totalSupply == null && floorPriceSats == null && listedCount == null && holderCount == null) return null;
  return {
    slug,
    name,
    totalSupply: totalSupply != null && totalSupply > 0 ? Math.trunc(totalSupply) : null,
    floorPriceSats: floorPriceSats != null && floorPriceSats > 0 ? Math.trunc(floorPriceSats) : null,
    listedCount: listedCount != null && listedCount >= 0 ? Math.trunc(listedCount) : null,
    holderCount: holderCount != null && holderCount > 0 ? Math.trunc(holderCount) : null,
    volume24hSats: volume24hSats != null && volume24hSats >= 0 ? Math.trunc(volume24hSats) : null,
    sales24h: sales24h != null && sales24h >= 0 ? Math.trunc(sales24h) : null,
  };
}

/** Pure parser (unit-tested). Only rows with a real inscription id and a positive sat price survive. */
export function parseBestInSlotListings(body: unknown, limit: number): BestInSlotListing[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const raw = Array.isArray(root.data) ? root.data : Array.isArray((root.data as Record<string, unknown> | undefined)?.listings) ? ((root.data as Record<string, unknown>).listings as unknown[]) : Array.isArray(root.listings) ? root.listings : [];
  const out: BestInSlotListing[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const inscriptionId = pick(row, "inscription_id", "inscriptionId", "id");
    const priceSats = num(pick(row, "price", "price_sats", "priceSats", "listed_price"));
    if (typeof inscriptionId !== "string" || !inscriptionId || priceSats == null || priceSats <= 0) continue;
    const seller = pick(row, "seller", "seller_address", "owner", "owner_address");
    const marketplace = pick(row, "marketplace", "source", "venue");
    out.push({
      inscriptionId,
      priceSats: Math.trunc(priceSats),
      sellerAddress: typeof seller === "string" ? seller : null,
      marketplace: typeof marketplace === "string" ? marketplace : null,
      inscriptionNumber: num(pick(row, "inscription_number", "inscriptionNumber")),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function bisFetch(path: string): Promise<{ status: number; body: unknown }> {
  const key = process.env.BESTINSLOT_API_KEY;
  if (!key) throw new Error("bestinslot: BESTINSLOT_API_KEY missing");
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { accept: "application/json", "x-api-key": key },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return { status: 404, body: null };
  if (!res.ok) throw new Error(`bestinslot: HTTP ${res.status} ${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Collection stats. `state` says why a null came back so callers never mistake "no key" for "no collection". */
export async function readBestInSlotCollectionStats(slug: string): Promise<{ state: CredentialState; stats: BestInSlotCollectionStats | null }> {
  if (bestInSlotCredentialState() === "credential-missing") return { state: "credential-missing", stats: null };
  try {
    const { status, body } = await bisFetch(`/collection/info?slug=${encodeURIComponent(slug)}`);
    if (status === 404) return { state: "not-found", stats: null };
    const stats = parseBestInSlotCollectionInfo(body, slug);
    return { state: stats ? "queried" : "not-found", stats };
  } catch (error) {
    if (/429|403|rate limit|quota/i.test(error instanceof Error ? error.message : String(error))) throw error; // let the lane jail the source
    return { state: "upstream-error", stats: null };
  }
}

/** Aggregated active listings for one collection, cheapest first. */
export async function readBestInSlotListings(slug: string, limit = 50): Promise<{ state: CredentialState; listings: BestInSlotListing[] }> {
  if (bestInSlotCredentialState() === "credential-missing") return { state: "credential-missing", listings: [] };
  try {
    const { status, body } = await bisFetch(
      `/collection/listings?slug=${encodeURIComponent(slug)}&sort_by=price&order=asc&offset=0&count=${Math.min(Math.max(limit, 1), 100)}`
    );
    if (status === 404) return { state: "not-found", listings: [] };
    return { state: "queried", listings: parseBestInSlotListings(body, limit) };
  } catch (error) {
    if (/429|403|rate limit|quota/i.test(error instanceof Error ? error.message : String(error))) throw error;
    return { state: "upstream-error", listings: [] };
  }
}

/** Run once when a real key exists: confirms auth and the documented response shape against a known collection. */
export async function verifyBestInSlotCredentials(slug = "bitcoin-frogs"): Promise<{ ok: boolean; state: CredentialState; raw?: unknown }> {
  if (bestInSlotCredentialState() === "credential-missing") return { ok: false, state: "credential-missing" };
  try {
    const { status, body } = await bisFetch(`/collection/info?slug=${encodeURIComponent(slug)}`);
    return { ok: status === 200 && parseBestInSlotCollectionInfo(body, slug) != null, state: status === 404 ? "not-found" : "queried", raw: body };
  } catch {
    return { ok: false, state: "upstream-error" };
  }
}

/** 1 sat = 1e10 in this app's 18-decimal atomic representation of BTC (8 decimals). Same convention as ordnet.ts's ordNetSatsToPriceWei. */
export function satsToPriceWei(sats: number): string {
  return (BigInt(Math.trunc(sats)) * 10_000_000_000n).toString();
}

export type BestInSlotStatsLaneResult = {
  state: "credential-missing" | "ran";
  candidates: number;
  updated: number;
  missed: number;
  cleared: number;
  errors: number;
};

/**
 * `bestinslot-stats` mesh lane: tracked Ordinals collections with the
 * oldest (or no) floor observation first; writes floor (BTC), listed/
 * supply/holders and 24h volume/sales as a vendor feed. A confirmed
 * not-found from BestInSlot for a collection whose displayed floor came
 * from BestInSlot counts a floor miss (two in a row null the floor,
 * migration 102). Clean no-op without a key so the scheduler sees exit 0.
 */
export async function runBestInSlotStatsLane(limit = 15): Promise<BestInSlotStatsLaneResult> {
  const result: BestInSlotStatsLaneResult = { state: "ran", candidates: 0, updated: 0, missed: 0, cleared: 0, errors: 0 };
  if (bestInSlotCredentialState() === "credential-missing") return { ...result, state: "credential-missing" };
  if (!hasPostgresConfig()) return result;
  const rows = await postgresQuery<{ contract_address: string }>(
    `SELECT c.contract_address
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1
     ORDER BY s.floor_observed_at ASC NULLS FIRST, c.id ASC
     LIMIT $2`,
    [CHAIN_SLUG, Math.max(1, limit)]
  );
  result.candidates = rows.rows.length;
  const { updateCollectionFloorOnly, updateCollectionSupplyFields, updateCollectionMarketStats, recordFloorSourceMiss } = await import("@/lib/market/multichain/store");
  for (const row of rows.rows) {
    const slug = row.contract_address;
    const { state, stats } = await readBestInSlotCollectionStats(slug);
    if (state === "not-found") {
      const miss = await recordFloorSourceMiss(CHAIN_SLUG, slug, BESTINSLOT_MARKETPLACE);
      result.missed += 1;
      if (miss.cleared) result.cleared += 1;
      continue;
    }
    if (state !== "queried" || !stats) {
      result.errors += 1;
      continue;
    }
    if (stats.floorPriceSats != null) {
      await updateCollectionFloorOnly(CHAIN_SLUG, slug, {
        floorPriceWei: satsToPriceWei(stats.floorPriceSats),
        floorPriceCurrency: "BTC",
        floorPriceMarketplace: BESTINSLOT_MARKETPLACE,
      });
    } else {
      const miss = await recordFloorSourceMiss(CHAIN_SLUG, slug, BESTINSLOT_MARKETPLACE);
      result.missed += 1;
      if (miss.cleared) result.cleared += 1;
    }
    await updateCollectionSupplyFields(CHAIN_SLUG, slug, {
      listedCount: stats.listedCount,
      totalSupply: stats.totalSupply,
      holderCount: stats.holderCount,
    });
    if (stats.volume24hSats != null || stats.sales24h != null) {
      await updateCollectionMarketStats(CHAIN_SLUG, slug, {
        volume24hWei: stats.volume24hSats != null ? satsToPriceWei(stats.volume24hSats) : null,
        sales24h: stats.sales24h,
        currentFloorPriceWei: stats.floorPriceSats != null ? satsToPriceWei(stats.floorPriceSats) : null,
        source: "vendor",
      });
    }
    result.updated += 1;
  }
  return result;
}
