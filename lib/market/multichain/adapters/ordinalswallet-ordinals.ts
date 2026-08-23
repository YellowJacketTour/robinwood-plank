/**
 * Ordinals Wallet adapter -- Bitcoin Ordinals' THIRD real collection-
 * discovery/snapshot source, alongside unisat-collections.ts and
 * ordiscan-ordinals.ts. Fully keyless: turbo.ordinalswallet.com requires
 * NO auth header at all, unlike both of those.
 *
 * Verified live 2026-08-23 against the real API (no docs page found;
 * shapes below are from live curl probing, not guessed):
 *
 * GET /collection/{slug}
 *   response (bitcoin-frogs): {id, name, icon, icon_inscription,
 *   description, slug, active, sponsored_priority, featured_priority,
 *   highest_inscription_num, lowest_inscription_num, total_supply,
 *   socials: {discord, twitter, website}, creator_address,
 *   gallery_inscription_id, verified}. NOTE: this endpoint does NOT return
 *   a floor price field at all -- confirmed live, `floor_price` is simply
 *   absent from the response for bitcoin-frogs (unlike a /collections list
 *   entry, which DOES carry one -- see ordinalswallet-collection-scan.ts's
 *   own header). /collection/{slug}/stats is the real floor source
 *   instead: {id, total_supply, floor_price, floor_price_per, volume_total,
 *   volume_day, listed, sales, owners}. `floor_price` there is an integer
 *   satoshi amount.
 *
 * A bad/unknown slug returns a real 404 with
 *   {"error":true,"message":"no rows returned by a query that expected to
 *   return at least one row"} -- confirmed live against a fake slug.
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";
import { checkSourceBudget, recordSourceFailure, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";

const SOURCE = "ordinalswallet-ordinals";
const API_BASE = "https://turbo.ordinalswallet.com";
// Not a real throttle -- turbo.ordinalswallet.com is keyless with no
// documented rate limit, and per explicit owner direction this app never
// self-imposes a limit unless it maps to a real, documented provider-side
// one. This number is only the required `allowance` parameter for the
// durable reserveProviderCapacity bookkeeping window (records real usage in
// plank_provider_windows for observability); set far above any realistic
// real usage so it can never actually block a request.
const DAILY_ALLOWANCE = 100_000_000_000;

type OrdinalsWalletCollection = {
  id?: string;
  name?: string | null;
  icon?: string | null;
  slug: string;
  total_supply?: number | null;
  socials?: { discord?: string | null; twitter?: string | null; website?: string | null } | null;
  creator_address?: string | null;
  verified?: boolean;
};

type OrdinalsWalletStats = {
  id?: string;
  total_supply?: number | null;
  floor_price?: number | null;
  listed?: number | null;
  sales?: number | null;
  owners?: number | null;
};

async function ordinalsWalletGet<T>(path: string): Promise<T> {
  if (await isSourceJailed(SOURCE)) throw new Error(`${SOURCE}: source jailed`);
  const gate = checkSourceBudget(SOURCE);
  if (!gate.allowed) throw new Error(`${SOURCE}: source ${gate.reason}`);
  const window = utcDayWindow(DAILY_ALLOWANCE);
  const account = "ordinalswallet:default";
  if (!(await reserveProviderCapacity(account, window))) {
    throw new Error(`${SOURCE}: durable daily ceiling`);
  }
  let settled = false;
  try {
    const res = await fetch(`${API_BASE}${path}`, { signal: AbortSignal.timeout(15_000) });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (!res.ok) {
      recordSourceFailure(SOURCE, res.status === 429 || res.status === 402 || res.status === 403);
      throw new Error(`${SOURCE}: ${res.status} ${res.statusText} fetching ${path}`);
    }
    recordSourceSuccess(SOURCE);
    return (await res.json()) as T;
  } catch (error) {
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    throw error;
  }
}

/**
 * Stored as an 18-decimal-equivalent string alongside every other chain's
 * price, same convention as unisat-collections.ts's satsToScaledString.
 */
function satsToScaledString(sats: number | null | undefined): string | null {
  if (typeof sats !== "number" || !Number.isFinite(sats) || sats <= 0) return null;
  return (BigInt(Math.round(sats)) * BigInt(10_000_000_000)).toString();
}

export const ordinalsWalletOrdinalsAdapter: ChainAdapter = {
  name: SOURCE,
  async fetchSnapshot({ contractAddress: slug }): Promise<CollectionSnapshot> {
    const entry = await ordinalsWalletGet<OrdinalsWalletCollection>(`/collection/${encodeURIComponent(slug)}`);
    const stats = await ordinalsWalletGet<OrdinalsWalletStats>(`/collection/${encodeURIComponent(slug)}/stats`).catch(() => null);
    const floor = satsToScaledString(stats?.floor_price);
    return {
      name: entry.name ?? null,
      imageUrl: entry.icon ?? null,
      externalUrl: entry.socials?.website ?? `https://ordinalswallet.com/collection/${slug}`,
      floorPriceWei: floor,
      floorPriceCurrency: floor != null ? "BTC" : null,
      floorPriceMarketplace: floor != null ? "ordinalswallet" : null,
      totalSupply: stats?.total_supply ?? entry.total_supply ?? null,
      listedCount: stats?.listed ?? null,
      creatorAddress: entry.creator_address ?? null,
      creatorHandle: extractHandleFromTwitterUrl(entry.socials?.twitter),
      holderCount: stats?.owners ?? null,
    };
  },
};
