import "server-only";
export { ordNetSatsToPriceWei, resolveOrdNetCollectionSlug } from "./ordnet-shared";
import { resolveOrdNetCollectionSlug } from "./ordnet-shared";

const BASE_URL = "https://ord.net/api/v1";

export type OrdNetListing = {
  listingId: string;
  inscriptionId: string;
  inscriptionNumber: string;
  inscriptionName: string;
  sellerAddress: string;
  priceSats: number;
  listedAt: string;
  listingExpiresAt: string | null;
  collection: { slug: string | null; name: string | null };
};

type CursorPage<T> = {
  listings: T[];
  pagination: { pageSize: number; hasNext: boolean; nextCursor: string | null };
};

function sessionToken(): string | null {
  return process.env.ORDNET_SESSION_TOKEN?.trim() || null;
}

/**
 * ORD.NET uses its own collection slug namespace. Operators can provide a
 * JSON map keyed by our canonical collection key without corrupting either
 * identity namespace, e.g. {"bitcoin-puppets":"bitcoin-puppets"}.
 */
export function isOrdNetConfigured(): boolean {
  return Boolean(sessionToken());
}

export async function fetchOrdNetListings(collectionKey: string, limit = 100): Promise<OrdNetListing[]> {
  const token = sessionToken();
  if (!token) return [];
  const collectionSlug = resolveOrdNetCollectionSlug(collectionKey);
  const rows: OrdNetListing[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${BASE_URL}/listings`);
    url.searchParams.set("collectionSlug", collectionSlug);
    url.searchParams.set("sort", "price");
    url.searchParams.set("limit", String(Math.min(100, Math.max(1, limit - rows.length))));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ORD.NET listings failed (${response.status})`);
    const page = (await response.json()) as CursorPage<OrdNetListing>;
    if (!Array.isArray(page.listings) || !page.pagination) throw new Error("ORD.NET returned an invalid listings page");
    rows.push(...page.listings.filter((row) => row?.listingId && row?.inscriptionId && Number.isSafeInteger(row?.priceSats) && row.priceSats > 0));
    cursor = page.pagination.hasNext ? page.pagination.nextCursor : null;
  } while (cursor && rows.length < limit);
  return rows.slice(0, limit);
}
