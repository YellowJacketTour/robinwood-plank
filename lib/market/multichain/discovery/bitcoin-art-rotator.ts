/**
 * Bitcoin collection art/name hydrator that NEVER stalls because one
 * vendor 403s.
 *
 * Live-verified 2026-08-20:
 * - UniSat open-api /collection_statistic_list → 403 exceeds rate limit
 * - Ordiscan /v1/collections → 429 monthly 1000 req cap
 * - CoinGecko /nfts/{id} Demo key still 200 (our v2 monthly KV was a
 *   false jail from counting list pages). Markets endpoint is PRO-only 401.
 * - Magic Eden /v2/ord/btc/* → 403 Cloudflare
 * - GET https://turbo.ordinalswallet.com/collection/{slug} → 200 with
 *   real `name` + `icon` (CDN / inscription preview). Exact slug only.
 *   404 = this indexer has no row; leave dash, cache none.
 *
 * Rotation: skip a jailed source, try the next. Persist per-source jail
 * in durable KV so a 403 in this process still cools the next worker.
 * Exact collection id/slug match only — never fuzzy name attach.
 */
import { postgresQuery } from "@/lib/postgres";
import { updateCollectionDisplay } from "@/lib/market/multichain/store";
import { durableKv } from "@/lib/market/durable-kv";
import {
  checkSourceBudget,
  recordSourceSuccess,
  recordSourceFailure,
} from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { preferHighestResImageUrl } from "@/lib/market/collection-art";

// OrdinalsWallet (turbo.ordinalswallet.com) is keyless and documents NO rate
// limit -- same live-confirmed finding as source-budget.ts's own
// DAILY_CEILING comment for "ordinals-wallet" (deliberately absent from that
// map). This number is only the required `allowance` parameter for the
// durable reserveProviderCapacity bookkeeping window (real-usage
// observability in plank_provider_windows), same pattern as
// ordinalswallet-collection-scan.ts's own DAILY_ALLOWANCE -- set far above
// any realistic real usage so it can never actually block a request. The
// previous value here (2_400) was a stale self-imposed throttle left over
// from before this session removed ordinals-wallet's ceiling from
// source-budget.ts; it was never updated to match and was silently blocking
// real OW lookups once 2,400/day were used.
const OW_DAILY_ALLOWANCE = 100_000_000_000;
// Real, current: CoinGecko's free Demo plan cap is 10,000/mo -- matches
// source-budget.ts's own "coingecko-nft": 8_000 DAILY_CEILING entry exactly
// (same-day burst guard, not the monthly one).
const CG_DAILY_ALLOWANCE = 8_000;

const OW = "ordinals-wallet";
const UNISAT = "unisat-collections";
const CG = "coingecko-nft";
const CHAIN = "bitcoin-mainnet";
const OW_NONE = (slug: string) => `plank:market:ow-art-none:${slug}`;
const JAIL_KV = (src: string) => `plank:market:source-jail-until:${src}`;

export type BitcoinArtRotatorResult = {
  candidates: number;
  filled: number;
  none: number;
  skipped: number;
  bySource: Record<string, number>;
};

async function isKvJailed(src: string): Promise<boolean> {
  const until = await durableKv.get<number>(JAIL_KV(src));
  return typeof until === "number" && Date.now() < until;
}

async function jailKv(src: string, ms: number): Promise<void> {
  await durableKv.set(JAIL_KV(src), Date.now() + ms, { ex: Math.ceil(ms / 1000) + 60 });
}

function sourceOpen(src: string): boolean {
  return checkSourceBudget(src).allowed;
}

async function canUse(src: string): Promise<boolean> {
  if (!sourceOpen(src)) return false;
  if (await isKvJailed(src)) return false;
  return true;
}

function isHttpsImage(url: string | null | undefined): string | null {
  if (!url) return null;
  const t = url.trim();
  if (!/^https:\/\//i.test(t)) return null;
  if (t.toLowerCase() === "null") return null;
  return t;
}

async function tryOrdinalsWallet(slug: string): Promise<{ name: string | null; imageUrl: string | null } | "none" | "skip"> {
  if (!(await canUse(OW))) return "skip";
  if ((await durableKv.get<string>(OW_NONE(slug))) === "1") return "none";
  const window = utcDayWindow(OW_DAILY_ALLOWANCE);
  const account = "ordinals-wallet:default";
  if (!(await reserveProviderCapacity(account, window))) return "skip";
  let settled = false;
  try {
    const res = await fetch(`https://turbo.ordinalswallet.com/collection/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (res.status === 404) {
      recordSourceSuccess(OW);
      await durableKv.set(OW_NONE(slug), "1", { ex: 7 * 24 * 60 * 60 });
      return "none";
    }
    if (res.status === 429 || res.status === 403) {
      recordSourceFailure(OW, true, 20 * 60_000);
      await jailKv(OW, 20 * 60_000);
      return "skip";
    }
    if (!res.ok) {
      recordSourceFailure(OW, false);
      return "skip";
    }
    recordSourceSuccess(OW);
    const body = (await res.json()) as { name?: string | null; icon?: string | null };
    const imageUrl = preferHighestResImageUrl(isHttpsImage(body.icon));
    const name = body.name?.trim() || null;
    if (!imageUrl && !name) return "none";
    return { name, imageUrl };
  } catch {
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    recordSourceFailure(OW, false);
    return "skip";
  }
}

// CoinGecko Demo plan's real documented rate limit is 30 calls/minute
// (docs.coingecko.com/docs/rate-limit). 2s between real CG calls keeps every
// call comfortably inside that, without touching OrdinalsWallet lookups
// (which have no documented limit -- see OW_DAILY_ALLOWANCE above) that make
// up most of this loop's real traffic.
const CG_MIN_INTERVAL_MS = 2_000;
let lastCgCallAt = 0;

async function tryCoinGecko(slug: string): Promise<{ name: string | null; imageUrl: string | null } | "none" | "skip"> {
  if (!(await canUse(CG))) return "skip";
  if (process.env.COINGECKO_API_KEY) {
    const month = new Date().toISOString().slice(0, 7);
    const mk = `plank:market:coingecko-nft-monthly-v3:${month}`;
    const used = (await durableKv.get<number>(mk)) ?? 0;
    if (used >= 9_000) {
      await jailKv(CG, 60 * 60_000);
      return "skip";
    }
    await durableKv.set(mk, used + 1, { ex: 40 * 24 * 60 * 60 });
  }
  const key = process.env.COINGECKO_API_KEY?.trim();
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) headers["x-cg-demo-api-key"] = key;
  const window = utcDayWindow(CG_DAILY_ALLOWANCE);
  const account = "coingecko-nft:default";
  if (!(await reserveProviderCapacity(account, window))) return "skip";
  const sinceLastCg = Date.now() - lastCgCallAt;
  if (sinceLastCg < CG_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, CG_MIN_INTERVAL_MS - sinceLastCg));
  }
  lastCgCallAt = Date.now();
  let settled = false;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/nfts/${encodeURIComponent(slug)}`, {
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (res.status === 404) {
      recordSourceSuccess(CG);
      return "none";
    }
    if (res.status === 429 || res.status === 402) {
      recordSourceFailure(CG, true, 30 * 60_000);
      await jailKv(CG, 30 * 60_000);
      return "skip";
    }
    if (!res.ok) {
      recordSourceFailure(CG, false);
      return "skip";
    }
    recordSourceSuccess(CG);
    const body = (await res.json()) as { name?: string; image?: { small?: string | null; small_2x?: string | null } };
    const imageUrl = preferHighestResImageUrl(isHttpsImage(body.image?.small_2x) || isHttpsImage(body.image?.small));
    const name = body.name?.trim() || null;
    if (!imageUrl && !name) return "none";
    return { name, imageUrl };
  } catch {
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    recordSourceFailure(CG, false);
    return "skip";
  }
}

export async function hydrateBitcoinArt(max = 40): Promise<BitcoinArtRotatorResult> {
  const rows = await postgresQuery<{ contract_address: string; name: string | null }>(
    `SELECT c.contract_address, c.name
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     WHERE c.chain_slug = $1
       AND (c.image_url IS NULL OR btrim(c.image_url) = '')
     ORDER BY COALESCE(s.holder_count, 0) DESC, COALESCE(s.volume_24h_wei, '0') DESC, c.id
     LIMIT $2`,
    [CHAIN, max]
  );
  const result: BitcoinArtRotatorResult = {
    candidates: rows.rows.length,
    filled: 0,
    none: 0,
    skipped: 0,
    bySource: { [OW]: 0, [CG]: 0, [UNISAT]: 0 },
  };

  for (const row of rows.rows) {
    const slug = row.contract_address;
    if (!slug) continue;

    let hit: { name: string | null; imageUrl: string | null } | "none" | "skip" = await tryOrdinalsWallet(slug);
    let src = OW;
    if (hit === "skip" || hit === "none") {
      const cg = await tryCoinGecko(slug);
      if (cg !== "skip" && cg !== "none") {
        hit = cg;
        src = CG;
      } else if (hit === "skip") {
        hit = cg;
      }
    }

    if (hit === "skip") {
      result.skipped += 1;
      continue;
    }
    if (hit === "none") {
      result.none += 1;
      continue;
    }
    await updateCollectionDisplay(CHAIN, slug, { name: hit.name, imageUrl: hit.imageUrl });
    result.filled += 1;
    result.bySource[src] = (result.bySource[src] ?? 0) + 1;
  }

  return result;
}
