import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import type { Listing } from "@/lib/market/types";
import type { NormalisedForeignListing } from "@/lib/market/foreign-listings";

/**
 * The RobinWood order book as the /market page shows it (2026-09-06, owner
 * report "planks collection data displays wrong floor price and grade and
 * other data on global marketplank").
 *
 * The native /market page merges every venue we mirror (OpenSea, PulpMarket)
 * into our own Seaport book and takes the floor from that merged book. The
 * global hub's RobinWood row read ONLY our own Postgres rows, so it showed a
 * higher floor and a smaller listed count than the collection's own page
 * (measured live: 22 listed at 0.03 ETH on the hub versus 82 listed at
 * 0.012 ETH on /market), and the hub grade, derived from floor and listed
 * count, inherited the error. One book, one floor: both surfaces read this.
 */
export type NativeBookSummary = {
  listings: Listing[];
  /** Cheapest live listing across every venue, or null when the book is empty. */
  floorWei: bigint | null;
  /** Where that cheapest listing lives: "marketplank" for our own rows. */
  floorVenue: string;
  listedCount: number;
  /** Our own live rows only, for callers that need the local-book figure. */
  ownListedCount: number;
};

async function withTimeout<T>(label: string, read: () => Promise<T[]>, ms = 2_000): Promise<T[]> {
  try {
    return await Promise.race([
      read(),
      new Promise<T[]>((resolve) =>
        setTimeout(() => {
          console.warn(`[native-book] ${label} read timed out; serving without it`);
          resolve([]);
        }, ms)
      ),
    ]);
  } catch {
    return [];
  }
}

export function summariseBook(listings: Listing[], ownListedCount: number): NativeBookSummary {
  let floorWei: bigint | null = null;
  let floorVenue = "marketplank";
  for (const l of listings) {
    let p: bigint;
    try {
      p = BigInt(l.priceWei);
    } catch {
      continue;
    }
    if (floorWei == null || p < floorWei) {
      floorWei = p;
      floorVenue = (l as { venue?: string }).venue ?? "marketplank";
    }
  }
  return { listings, floorWei, floorVenue, listedCount: listings.length, ownListedCount };
}

export async function readNativeRobinwoodBook(opts: { hostHeader?: string | null } = {}): Promise<NativeBookSummary> {
  const { getListings } = await import("@/lib/market/orders-store");
  const withRetry = async (slug: string) => {
    try {
      return await getListings(slug, "robinhood");
    } catch {
      try {
        return await getListings(slug, "robinhood");
      } catch {
        return [];
      }
    }
  };
  const bySlug = await withRetry("robinwood");
  const byContract = bySlug.length > 0 ? [] : await withRetry(NFT_CONTRACT_ADDRESS.toLowerCase());
  const own = bySlug.length >= byContract.length ? bySlug : byContract;

  const { splitLiveOrders } = await import("@/lib/market/order-status");
  let live: Listing[];
  try {
    live = (await splitLiveOrders(own as Array<{ id?: string; rawOrder?: unknown }>)).live as unknown as Listing[];
  } catch {
    live = own as unknown as Listing[];
  }

  if (live.length === 0) {
    const { fetchCanonicalRobinwoodStats } = await import("@/lib/market/canonical-robinwood");
    const canonical = await fetchCanonicalRobinwoodStats({ hostHeader: opts.hostHeader ?? null }).catch(() => null);
    if (canonical && canonical.listings.length > 0) live = canonical.listings as unknown as Listing[];
  }

  const { readOpenSeaListings } = await import("@/lib/market/opensea");
  const { readPulpListings } = await import("@/lib/market/pulp");
  const foreign: NormalisedForeignListing[] = [
    ...(await withTimeout("opensea", readOpenSeaListings)),
    ...(await withTimeout("pulp", () => readPulpListings())),
  ];
  const { mergeBook } = await import("@/lib/market/book");
  const merged = mergeBook(live, foreign, "robinwood");
  return summariseBook(merged, live.length);
}
