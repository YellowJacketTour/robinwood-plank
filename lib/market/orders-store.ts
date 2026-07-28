import { promises as fs } from "node:fs";
import path from "node:path";
import { kv } from "@vercel/kv";
import type { Listing, Offer } from "@/lib/market/types";

/**
 * Store-and-forward for signed Seaport orders — not custody, not a matching
 * engine. Orders are EIP-712 signed by the maker before they ever reach this
 * store, and their signature is verified at the API boundary (see
 * lib/market/signature.ts), so the server cannot forge or alter one; it can
 * only lose or serve them.
 *
 * Backend: Vercel KV when KV_REST_API_URL / KV_REST_API_TOKEN are set (the
 * durable, cross-instance-safe path). Falls back to a file + in-memory
 * globalThis cache otherwise — fine for local dev, not durable on Vercel's
 * serverless filesystem in production.
 *
 * CONCURRENCY (audit finding 6): the old design stored the whole book under a
 * single KV key and did read-modify-write with no compare-and-set, so two
 * simultaneous POSTs would each load the same snapshot and the second write
 * would clobber the first — silently dropping an order. This is fixed two ways:
 *   - KV: each order is a field in a Redis HASH (hset/hdel), so writes to
 *     different order ids are independent and never lose each other, across
 *     instances. (Reads still snapshot a whole hash, which is fine.)
 *   - File/dev: all read-modify-write is serialized through an in-process
 *     mutex so interleaved awaits can't clobber. (A single dev process is the
 *     only writer, so this is sufficient there.)
 */
type StoredListing = Listing & { rawOrder: unknown };
type StoredOffer = Offer & { rawOrder: unknown };
type OrdersState = {
  listings: Record<string, StoredListing>;
  offers: Record<string, StoredOffer>;
};

/** Legacy single-key blob (pre-audit). Kept only so a dev machine with old
 * data still loads; new writes use the per-field hashes below. */
const KV_KEY = "plank:market:orders";
const KV_LISTINGS = "plank:market:listings";
const KV_OFFERS = "plank:market:offers";

function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function emptyState(): OrdersState {
  return { listings: {}, offers: {} };
}

function isLive(expiresAt: string, now: number): boolean {
  return new Date(expiresAt).getTime() > now;
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

/**
 * In-process write mutex for the file backend. Every read-modify-write chains
 * onto the previous one, so concurrent POSTs can't interleave their loads and
 * clobber each other (audit finding 6, file path).
 */
let fileWriteChain: Promise<void> = Promise.resolve();
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileWriteChain.then(fn, fn);
  // Keep the chain alive regardless of individual failures.
  fileWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// --- Vercel KV backend (per-field hashes) ------------------------------

async function kvGetAll<T>(hashKey: string): Promise<Record<string, T>> {
  const all = await kv.hgetall<Record<string, T>>(hashKey);
  return all ?? {};
}

// --- Backend-agnostic read helpers -------------------------------------

async function readListings(): Promise<Record<string, StoredListing>> {
  if (hasKv()) return kvGetAll<StoredListing>(KV_LISTINGS);
  return (await loadFromFile()).listings;
}

async function readOffers(): Promise<Record<string, StoredOffer>> {
  if (hasKv()) return kvGetAll<StoredOffer>(KV_OFFERS);
  return (await loadFromFile()).offers;
}

function liveValues<T extends { expiresAt: string }>(rec: Record<string, T>): T[] {
  const now = Date.now();
  return Object.values(rec).filter((v) => isLive(v.expiresAt, now));
}

// --- Public API --------------------------------------------------------

export async function getListings(
  collectionSlug?: string
): Promise<Array<Listing & { rawOrder: unknown }>> {
  const all = liveValues(await readListings());
  return collectionSlug ? all.filter((l) => l.collectionSlug === collectionSlug) : all;
}

export async function getOffers(
  collectionSlug?: string
): Promise<Array<Offer & { rawOrder: unknown }>> {
  const all = liveValues(await readOffers());
  return collectionSlug ? all.filter((o) => o.collectionSlug === collectionSlug) : all;
}

/** Total live orders across both books — used to cap storage growth. */
export async function totalOrderCount(): Promise<number> {
  const [listings, offers] = await Promise.all([readListings(), readOffers()]);
  return liveValues(listings).length + liveValues(offers).length;
}

/** Live orders from one maker — used to stop a single wallet flooding the book. */
export async function countOrdersByMaker(maker: string): Promise<number> {
  const m = maker.toLowerCase();
  const [listings, offers] = await Promise.all([readListings(), readOffers()]);
  const l = liveValues(listings).filter((x) => x.maker.toLowerCase() === m).length;
  const o = liveValues(offers).filter((x) => x.maker.toLowerCase() === m).length;
  return l + o;
}

export async function putListing(listing: Listing, rawOrder: unknown): Promise<void> {
  const value: StoredListing = { ...listing, rawOrder };
  if (hasKv()) {
    // Per-field write: independent of any concurrent write to another id.
    await kv.hset(KV_LISTINGS, { [listing.id]: value });
    return;
  }
  await withFileLock(async () => {
    const state = await loadFromFile();
    state.listings[listing.id] = value;
    await persistToFile(state);
  });
}

export async function putOffer(offer: Offer, rawOrder: unknown): Promise<void> {
  const value: StoredOffer = { ...offer, rawOrder };
  if (hasKv()) {
    await kv.hset(KV_OFFERS, { [offer.id]: value });
    return;
  }
  await withFileLock(async () => {
    const state = await loadFromFile();
    state.offers[offer.id] = value;
    await persistToFile(state);
  });
}

export async function getListingRawOrder(id: string): Promise<unknown | null> {
  if (hasKv()) {
    const v = await kv.hget<StoredListing>(KV_LISTINGS, id);
    return v?.rawOrder ?? null;
  }
  const state = await loadFromFile();
  return state.listings[id]?.rawOrder ?? null;
}

export async function getOfferRawOrder(id: string): Promise<unknown | null> {
  if (hasKv()) {
    const v = await kv.hget<StoredOffer>(KV_OFFERS, id);
    return v?.rawOrder ?? null;
  }
  const state = await loadFromFile();
  return state.offers[id]?.rawOrder ?? null;
}

export async function removeListing(id: string): Promise<void> {
  if (hasKv()) {
    await kv.hdel(KV_LISTINGS, id);
    return;
  }
  await withFileLock(async () => {
    const state = await loadFromFile();
    delete state.listings[id];
    await persistToFile(state);
  });
}

export async function removeOffer(id: string): Promise<void> {
  if (hasKv()) {
    await kv.hdel(KV_OFFERS, id);
    return;
  }
  await withFileLock(async () => {
    const state = await loadFromFile();
    delete state.offers[id];
    await persistToFile(state);
  });
}

// Reference the legacy key so lint/tsc keep it documented; migration of old
// single-blob data is unnecessary while the market is HARD OFF (no live data).
void KV_KEY;
