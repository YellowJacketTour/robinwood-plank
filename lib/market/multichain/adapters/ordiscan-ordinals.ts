/**
 * Ordiscan adapter -- Bitcoin Ordinals' second real collection-discovery
 * source alongside unisat-collections.ts.
 *
 * Verified live 2026-08-20 (ORDISCAN_API_KEY required):
 *
 * GET /v1/collection/{slug} (singular "collection" -- "collections/{slug}"
 * 404s)
 *   headers: Authorization: Bearer <ORDISCAN_API_KEY>
 *   response: {"data": {name, slug, description, twitter_link,
 *   discord_link, website_link, item_count}} -- confirmed live against a
 *   real slug ("adderrels") pulled from the collections list.
 *
 * Current Ordiscan API also exposes GET /v1/collection/{slug}/market.
 * It returns a real floor in sats and market cap, but no listed count.
 *
 * totalSupply IS real here (the response's own `item_count`), and
 * creatorHandle IS real here (twitter_link, parsed via the shared
 * extractHandleFromTwitterUrl helper) -- unlike helius-solana.ts, which has
 * neither.
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";
import { checkSourceBudget, recordSourceFailure, recordSourceSuccess } from "@/lib/market/multichain/discovery/source-budget";
import { reserveProviderCapacity, settleProviderCapacity, utcDayWindow } from "@/lib/market/multichain/control-plane";
import { isSourceJailed } from "@/lib/market/multichain/mesh/jail";

const ORDISCAN_DAILY_ALLOWANCE = 24;

function requireApiKey(): string {
  const key = process.env.ORDISCAN_API_KEY?.trim();
  if (!key) throw new Error("ordiscan-ordinals: ORDISCAN_API_KEY is not configured");
  return key;
}

type OrdiscanCollection = {
  name?: string | null;
  slug: string;
  description?: string | null;
  twitter_link?: string | null;
  discord_link?: string | null;
  website_link?: string | null;
  item_count?: number | null;
};

type OrdiscanMarket = { floor_price_in_sats?: number | null };

async function ordiscanGet<T>(path: string, key: string): Promise<T> {
  if (await isSourceJailed("ordiscan")) throw new Error("ordiscan-ordinals: source jailed");
  const gate = checkSourceBudget("ordiscan");
  if (!gate.allowed) throw new Error(`ordiscan-ordinals: source ${gate.reason}`);
  const window = utcDayWindow(ORDISCAN_DAILY_ALLOWANCE);
  const account = "ordiscan:default";
  if (!(await reserveProviderCapacity(account, window))) {
    throw new Error("ordiscan-ordinals: durable daily ceiling");
  }
  let settled = false;
  try {
    const res = await fetch(`https://api.ordiscan.com/v1${path}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    await settleProviderCapacity(account, window, 1, true);
    settled = true;
    if (!res.ok) {
      recordSourceFailure("ordiscan", res.status === 429 || res.status === 402 || res.status === 403);
      throw new Error(`ordiscan-ordinals: ${res.status} ${res.statusText} fetching ${path}`);
    }
    recordSourceSuccess("ordiscan");
    return ((await res.json()) as { data: T }).data;
  } catch (error) {
    // Network failures still consume a provider attempt in practice.
    if (!settled) await settleProviderCapacity(account, window, 1, true).catch(() => {});
    throw error;
  }
}

export const ordiscanOrdinalsAdapter: ChainAdapter = {
  name: "ordiscan-ordinals",
  async fetchSnapshot({ contractAddress: slug }): Promise<CollectionSnapshot> {
    const key = requireApiKey();
    const entry = await ordiscanGet<OrdiscanCollection>(`/collection/${encodeURIComponent(slug)}`, key);
    const market = await ordiscanGet<OrdiscanMarket>(`/collection/${encodeURIComponent(slug)}/market`, key).catch(() => null);
    const floorSats = market?.floor_price_in_sats;
    return {
      name: entry.name ?? null,
      imageUrl: null,
      externalUrl: entry.website_link ?? `https://ordiscan.com/collection/${slug}`,
      // Snapshot price fields use 18-decimal base units across chains. One
      // sat is 1e10 of those BTC base units, matching the existing UniSat adapter.
      floorPriceWei: floorSats != null && floorSats > 0 ? (BigInt(Math.trunc(floorSats)) * 10_000_000_000n).toString() : null,
      floorPriceCurrency: floorSats != null && floorSats > 0 ? "BTC" : null,
      floorPriceMarketplace: floorSats != null && floorSats > 0 ? "ordiscan" : null,
      totalSupply: entry.item_count ?? null,
      listedCount: null,
      creatorAddress: null,
      creatorHandle: extractHandleFromTwitterUrl(entry.twitter_link),
    };
  },
};
