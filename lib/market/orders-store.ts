import { promises as fs } from "node:fs";
import path from "node:path";
import { kv } from "@vercel/kv";
import type { Listing, Offer } from "@/lib/market/types";

/**
 * Store-and-forward for signed Seaport orders — not custody, not a matching
 * engine. Orders are EIP-712 signed by the maker before they ever reach this
 * store, so the server cannot forge or alter one; it can only lose or serve
 * them.
 *
 * Backend: Vercel KV when KV_REST_API_URL / KV_REST_API_TOKEN are set (the
 * durable, cross-instance-safe path — set those env vars whenever you have
 * a KV/Upstash instance ready). Falls back to a file + in-memory globalThis
 * cache otherwise, same pattern as lib/boards-store.ts — fine for local
 * dev, not durable on Vercel's serverless filesystem in production.
 */
type OrdersState = {
  listings: Record<string, Listing & { rawOrder: unknown }>;
  offers: Record<string, Offer & { rawOrder: unknown }>;
};

const KV_KEY = "plank:market:orders";

function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function emptyState(): OrdersState {
  return { listings: {}, offers: {} };
}

// --- File + memory fallback (dev / no KV configured) -----------------------

type GlobalOrders = { __plankMarketOrders?: OrdersState };

function g(): GlobalOrders {
  return globalThis as GlobalOrders;
}

const DATA_PATH = path.join(process.cwd(), ".data", "market-orders.json");

async function loadFromFile(): Promise<OrdersState> {
  if (g().__plankMarketOrders) return g().__plankMarketOrders!;
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    g().__plankMarketOrders = JSON.parse(raw) as OrdersState;
  } catch {
    g().__plankMarketOrders = emptyState();
  }
  return g().__plankMarketOrders!;
}

async function persistToFile(state: OrdersState): Promise<void> {
  g().__plankMarketOrders = state;
  try {
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
    await fs.writeFile(DATA_PATH, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort — the in-memory copy on globalThis still serves this
    // warm instance even if disk persistence fails (e.g. read-only fs).
  }
}

// --- Vercel KV backend -------------------------------------------------

async function loadFromKv(): Promise<OrdersState> {
  const state = await kv.get<OrdersState>(KV_KEY);
  return state ?? emptyState();
}

async function persistToKv(state: OrdersState): Promise<void> {
  await kv.set(KV_KEY, state);
}

// --- Backend-agnostic API ----------------------------------------------

async function load(): Promise<OrdersState> {
  return hasKv() ? loadFromKv() : loadFromFile();
}

async function persist(state: OrdersState): Promise<void> {
  return hasKv() ? persistToKv(state) : persistToFile(state);
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

/** Total live orders across both books — used to cap storage growth. */
export async function totalOrderCount(): Promise<number> {
  const state = pruneExpired(await load());
  return Object.keys(state.listings).length + Object.keys(state.offers).length;
}

/** Live orders from one maker — used to stop a single wallet flooding the book. */
export async function countOrdersByMaker(maker: string): Promise<number> {
  const state = pruneExpired(await load());
  const m = maker.toLowerCase();
  const listings = Object.values(state.listings).filter((l) => l.maker.toLowerCase() === m);
  const offers = Object.values(state.offers).filter((o) => o.maker.toLowerCase() === m);
  return listings.length + offers.length;
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
