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
 * HONEST LIMITATION, CONFIRMED LIVE NOT ASSUMED: no floor-price or
 * marketplace-stats endpoint exists in this API at all, unlike UniSat's
 * collection_statistic. fetchSnapshot therefore returns floorPriceWei/
 * floorPriceCurrency/floorPriceMarketplace/listedCount/imageUrl as honest
 * null rather than fabricating them or cross-referencing another
 * marketplace -- same pattern as helius-solana.ts's DAS adapter, which has
 * the identical real gap for a different reason (asset data, not
 * marketplace data; here it's simply an API that doesn't expose it).
 *
 * totalSupply IS real here (the response's own `item_count`), and
 * creatorHandle IS real here (twitter_link, parsed via the shared
 * extractHandleFromTwitterUrl helper) -- unlike helius-solana.ts, which has
 * neither.
 */
import type { ChainAdapter, CollectionSnapshot } from "@/lib/market/multichain/types";
import { extractHandleFromTwitterUrl } from "@/lib/market/multichain/twitter-handle";

const API_BASE = "https://api.ordiscan.com/v1/collection";

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

export const ordiscanOrdinalsAdapter: ChainAdapter = {
  name: "ordiscan-ordinals",
  async fetchSnapshot({ contractAddress: slug }): Promise<CollectionSnapshot> {
    const key = requireApiKey();
    const res = await fetch(`${API_BASE}/${encodeURIComponent(slug)}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      throw new Error(`ordiscan-ordinals: ${res.status} ${res.statusText} fetching collection/${slug}`);
    }
    const body = (await res.json()) as { data: OrdiscanCollection };
    const entry = body.data;
    return {
      name: entry.name ?? null,
      imageUrl: null,
      externalUrl: entry.website_link ?? `https://ordiscan.com/collection/${slug}`,
      // No real floor-price/marketplace-stats endpoint exists in this API --
      // see header. Never fabricated.
      floorPriceWei: null,
      floorPriceCurrency: null,
      floorPriceMarketplace: null,
      totalSupply: entry.item_count ?? null,
      listedCount: null,
      creatorAddress: null,
      creatorHandle: extractHandleFromTwitterUrl(entry.twitter_link),
    };
  },
};
