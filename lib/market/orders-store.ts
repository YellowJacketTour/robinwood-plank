import { promises as fs } from "node:fs";
import path from "node:path";
import type { Listing, Offer } from "@/lib/market/types";

/**
 * Store-and-forward for signed Seaport orders — not custody, not a matching
 * engine. Orders are EIP-712 signed by the maker before they ever reach this
 * store, so the server cannot forge or alter one; it can only lose or serve
 * them. Same file+memory persistence pattern as lib/boards-store.ts.
 */
type OrdersState = {
  listings: Record<string, Listing & { rawOrder: unknown }>;
  offers: Record<string, Offer & { rawOrder: unknown }>;
};

type GlobalOrders = { __plankMarketOrders?: OrdersState };

function g(): GlobalOrders {
  return globalThis as GlobalOrders;
}

function emptyState(): OrdersState {
  return { listings: {}, offers: {} };
}

const DATA_PATH = path.join(process.cwd(), ".data", "market-orders.json");

async function load(): Promise<OrdersState> {
  if (g().__plankMarketOrders) return g().__plankMarketOrders!;
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    g().__plankMarketOrders = JSON.parse(raw) as OrdersState;
  } catch {
    g().__plankMarketOrders = emptyState();
  }
  return g().__plankMarketOrders!;
}

async function persist(state: OrdersState): Promise<void> {
  g().__plankMarketOrders = state;
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort — the in-memory copy on globalThis still serves this
    // warm instance even if disk persistence fails (e.g. read-only fs).
  }
}

function pruneExpired(state: OrdersState): OrdersState {
  const now = Date.now();
  const isLive = (expiresAt: string) => new Date(expiresAt).getTime() > now;
  return {
    listings: Object.fromEntries(
      Object.entries(state.listings).filter(([, l]) => isLive(l.expiresAt))
    ),
    offers: Object.fromEntries(
      Object.entries(state.offers).filter(([, o]) => isLive(o.expiresAt))
    ),
  };
}

export async function getListings(
  collectionSlug?: string
): Promise<Array<Listing & { rawOrder: unknown }>> {
  const state = pruneExpired(await load());
  const all = Object.values(state.listings);
  return collectionSlug ? all.filter((l) => l.collectionSlug === collectionSlug) : all;
}

export async function getOffers(
  collectionSlug?: string
): Promise<Array<Offer & { rawOrder: unknown }>> {
  const state = pruneExpired(await load());
  const all = Object.values(state.offers);
  return collectionSlug ? all.filter((o) => o.collectionSlug === collectionSlug) : all;
}

export async function putListing(listing: Listing, rawOrder: unknown): Promise<void> {
  const state = pruneExpired(await load());
  state.listings[listing.id] = { ...listing, rawOrder };
  await persist(state);
}

export async function putOffer(offer: Offer, rawOrder: unknown): Promise<void> {
  const state = pruneExpired(await load());
  state.offers[offer.id] = { ...offer, rawOrder };
  await persist(state);
}

export async function getListingRawOrder(id: string): Promise<unknown | null> {
  const state = await load();
  return state.listings[id]?.rawOrder ?? null;
}

export async function getOfferRawOrder(id: string): Promise<unknown | null> {
  const state = await load();
  return state.offers[id]?.rawOrder ?? null;
}

export async function removeListing(id: string): Promise<void> {
  const state = await load();
  delete state.listings[id];
  await persist(state);
}

export async function removeOffer(id: string): Promise<void> {
  const state = await load();
  delete state.offers[id];
  await persist(state);
}
