import { durableKv as kv, hasDurableKv } from "@/lib/market/durable-kv";
import type { NormalisedForeignListing } from "@/lib/market/foreign-listings";

/**
 * OpenSea API v2 client with a self-renewing credential.
 *
 * OpenSea supports Robinhood Chain (chain identifier "robinhood"), so the
 * collection's activity there is visible to us — the older claim in this repo
 * that no aggregator indexes chain 4663 is wrong.
 *
 * The credential is the interesting part. Free keys are issued instantly with
 * no signup but **expire after 30 days**, and a silently expired key would make
 * volume quietly stop updating — the same class of failure as the sales catalog
 * expiring with nothing to rebuild it. So the key is treated as managed state
 * rather than static config: stored in PostgreSQL, checked on every cron run,
 * and requested afresh before it lapses.
 *
 * Set OPENSEA_API_KEY to override with a full (non-expiring) key from
 * opensea.io/settings/developer. That takes precedence and is never rotated.
 *
 * Server-only. The key must never reach a client bundle or a public response.
 */

const KEY_KV = "plank:market:opensea-api-key-v1";
/** Last good collection stats from OpenSea. No TTL — see migration 003. */
export const OPENSEA_STATS_KV = "plank:market:opensea-collection-stats-v1";
const BASE = "https://api.opensea.io/api/v2";

/** The collection as OpenSea knows it. */
export const OPENSEA_COLLECTION_SLUG = "robinwoodplanks42069";

/** Renew with a week in hand — a cron can miss a few runs without lapsing. */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Wait one cron cycle before retrying a failed key request.
 *
 * OpenSea allows one key creation per hour, so the obvious choice is to back
 * off for an hour — but that is the wrong reasoning. We do not know where in
 * their window we are, only that we were refused. A refused request costs one
 * cheap HTTP call and nothing else, so retrying every cycle recovers as soon as
 * the window opens instead of idling for up to an hour after it already has.
 * With a 7-day renewal margin, four wasted requests an hour is not a concern;
 * a key lapsing because we slept through the reset would be.
 */
const ISSUE_COOLDOWN_MS = 14 * 60 * 1000;

export type StoredOpenSeaKey = {
  apiKey: string;
  /** ISO-8601 from OpenSea. */
  expiresAt: string;
  issuedAt: number;
  name?: string;
  /** Last issuance ATTEMPT, success or not — drives the cooldown. */
  lastAttemptAt?: number;
};

function envKey(): string | null {
  return process.env.OPENSEA_API_KEY?.trim() || null;
}

async function readStored(): Promise<StoredOpenSeaKey | null> {
  if (!hasDurableKv()) return null;
  try {
    return (await kv.get<StoredOpenSeaKey>(KEY_KV)) ?? null;
  } catch {
    return null;
  }
}

async function writeStored(value: StoredOpenSeaKey): Promise<void> {
  if (!hasDurableKv()) return;
  try {
    // No TTL. This is managed state, not a cache — see migration 003.
    await kv.set(KEY_KV, value);
  } catch {
    /* a failed write just means we request another next run */
  }
}

function msUntilExpiry(stored: StoredOpenSeaKey): number {
  const t = Date.parse(stored.expiresAt);
  return Number.isFinite(t) ? t - Date.now() : -1;
}

/**
 * The key to use right now, or null if we have none.
 *
 * Read-only by design: request paths must never ask for a key. Several Passenger
 * workers hitting a 1-per-hour endpoint at once would rate-limit each other
 * and leave everyone without a key. Requesting one is the cron's job.
 */
export async function getOpenSeaApiKey(): Promise<string | null> {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  const stored = await readStored();
  if (!stored?.apiKey) return null;
  // Serve it even past expiry — OpenSea decides, not our clock skew.
  return stored.apiKey;
}

async function requestKey(): Promise<StoredOpenSeaKey | null> {
  const res = await fetch(`${BASE}/auth/keys`, {
    method: "POST",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `OpenSea key request failed: HTTP ${res.status} ${body.slice(0, 160)}`
    );
  }
  const json = (await res.json()) as {
    api_key?: string;
    expires_at?: string;
    name?: string;
  };
  if (!json.api_key || !json.expires_at) {
    throw new Error("OpenSea key request returned an unexpected shape.");
  }
  return {
    apiKey: json.api_key,
    expiresAt: json.expires_at,
    issuedAt: Date.now(),
    name: json.name,
  };
}

export type KeyEnsureResult = {
  status: "env" | "fresh" | "renewed" | "cooldown" | "failed" | "unavailable";
  /** Safe to log — never contains the key. */
  detail: string;
};

/**
 * Obtain or renew the API credential as needed. Call from the cron only.
 *
 * NOTE ON WORDING: this is an HTTP request to OpenSea for an API key. It is
 * unrelated to NFT minting — the collection is sold out and nothing here ever
 * touches a contract.
 */
export async function ensureOpenSeaKey(): Promise<KeyEnsureResult> {
  if (envKey()) {
    return { status: "env", detail: "using OPENSEA_API_KEY from the environment" };
  }
  if (!hasDurableKv()) {
    return { status: "unavailable", detail: "no datastore configured to hold the key" };
  }

  const stored = await readStored();
  if (stored?.apiKey) {
    const remaining = msUntilExpiry(stored);
    if (remaining > RENEW_BEFORE_MS) {
      const days = Math.floor(remaining / 86_400_000);
      return { status: "fresh", detail: `key valid for ${days} more day(s)` };
    }
  }

  const lastAttempt = stored?.lastAttemptAt ?? 0;
  const sinceAttempt = Date.now() - lastAttempt;
  if (sinceAttempt < ISSUE_COOLDOWN_MS) {
    const mins = Math.ceil((ISSUE_COOLDOWN_MS - sinceAttempt) / 60_000);
    return {
      status: "cooldown",
      detail: `renewal needed but OpenSea allows one key per hour; retrying in ~${mins}m`,
    };
  }

  // Record the attempt BEFORE the call, so a crash mid-request still burns the
  // cooldown rather than letting the next run hammer a rate-limited endpoint.
  if (stored) await writeStored({ ...stored, lastAttemptAt: Date.now() });

  try {
    const issued = await requestKey();
    if (!issued) return { status: "failed", detail: "key request returned nothing" };
    await writeStored({ ...issued, lastAttemptAt: Date.now() });
    return {
      status: "renewed",
      detail: `new key expires ${issued.expiresAt}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Re-read rather than trusting the `stored` captured at the top of this
    // function: if another process (another Passenger worker, another cron
    // overlap) successfully wrote a real key while THIS call was in flight,
    // `stored` here is stale-null even though a good key now exists. Writing
    // the empty placeholder unconditionally on stale-null was a real bug --
    // confirmed live 2026-08-17, two ensureOpenSeaKey() calls close together
    // clobbered a just-issued valid key with this placeholder. Only seed the
    // placeholder (so openSeaKeyStatus has something sane to report on a
    // true first-ever failure) if a FRESH read still finds nothing.
    const freshlyStored = await readStored();
    if (!freshlyStored) {
      await writeStored({
        apiKey: "",
        expiresAt: new Date(0).toISOString(),
        issuedAt: 0,
        lastAttemptAt: Date.now(),
      });
    }
    return { status: "failed", detail };
  }
}

/** Credential state for /api/health — never includes the key itself. */
export async function openSeaKeyStatus(): Promise<{
  source: "env" | "managed" | "none";
  expiresAt: string | null;
  daysRemaining: number | null;
}> {
  if (envKey()) return { source: "env", expiresAt: null, daysRemaining: null };
  const stored = await readStored();
  if (!stored?.apiKey) return { source: "none", expiresAt: null, daysRemaining: null };
  const remaining = msUntilExpiry(stored);
  return {
    source: "managed",
    expiresAt: stored.expiresAt,
    daysRemaining: Math.floor(remaining / 86_400_000),
  };
}

/**
 * GET an OpenSea endpoint. Returns null rather than throwing on any failure:
 * OpenSea being unreachable must never blank Marketplank's own numbers.
 */
export async function openSeaGet<T>(path: string): Promise<T | null> {
  const key = await getOpenSeaApiKey();
  if (!key) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-api-key": key, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[opensea] GET ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    console.warn(
      `[opensea] GET ${path} failed:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

export type OpenSeaCollectionStats = {
  total?: {
    volume?: number;
    sales?: number;
    average_price?: number;
    num_owners?: number;
    market_cap?: number;
    floor_price?: number;
    floor_price_symbol?: string;
  };
  intervals?: Array<{
    interval?: string;
    volume?: number;
    volume_change?: number;
    sales?: number;
  }>;
};

export async function fetchOpenSeaCollectionStats(
  slug: string
): Promise<OpenSeaCollectionStats | null> {
  return openSeaGet<OpenSeaCollectionStats>(
    `/collections/${encodeURIComponent(slug)}/stats`
  );
}

export type StoredOpenSeaStats = {
  volume: number | null;
  sales: number | null;
  floorPrice: number | null;
  floorSymbol: string | null;
  numOwners: number | null;
  fetchedAt: number;
};

export async function readOpenSeaStats(): Promise<StoredOpenSeaStats | null> {
  if (!hasDurableKv()) return null;
  try {
    return (await kv.get<StoredOpenSeaStats>(OPENSEA_STATS_KV)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Refresh OpenSea's own collection figures.
 *
 * Kept separate from our sales catalog rather than added to it: an OpenSea sale
 * on this chain already appears in our catalog (it gates on the royalty leg,
 * not on the venue), so summing the two would double count. Reconciling by
 * transaction hash is the next step; storing their number first lets us see how
 * far apart the two are before deciding.
 *
 * Never overwrites good data with nothing — an outage keeps the last figure.
 */
export async function refreshOpenSeaStats(): Promise<StoredOpenSeaStats | null> {
  const stats = await fetchOpenSeaCollectionStats(OPENSEA_COLLECTION_SLUG);
  const t = stats?.total;
  if (!t || (t.volume == null && t.sales == null)) return readOpenSeaStats();

  const next: StoredOpenSeaStats = {
    volume: t.volume ?? null,
    sales: t.sales ?? null,
    floorPrice: t.floor_price ?? null,
    floorSymbol: t.floor_price_symbol ?? null,
    numOwners: t.num_owners ?? null,
    fetchedAt: Date.now(),
  };
  if (hasDurableKv()) {
    try {
      await kv.set(OPENSEA_STATS_KV, next);
    } catch {
      /* next run retries */
    }
  }
  return next;
}

export type OpenSeaListing = {
  order_hash?: string;
  chain?: string;
  price?: { current?: { currency?: string; decimals?: number; value?: string } };
  protocol_address?: string;
  protocol_data?: {
    parameters?: {
      offerer?: string;
      zone?: string;
      orderType?: number;
      conduitKey?: string;
      offer?: Array<{ itemType?: number; token?: string; identifierOrCriteria?: string }>;
      consideration?: Array<{
        itemType?: number;
        token?: string;
        startAmount?: string;
        recipient?: string;
      }>;
    };
    signature?: string;
  };
};

export async function fetchOpenSeaListings(
  slug: string,
  limit = 50,
  cursor?: string | null
): Promise<{ listings?: OpenSeaListing[]; next?: string } | null> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("next", cursor);
  return openSeaGet(
    `/listings/collection/${encodeURIComponent(slug)}/all?${params.toString()}`
  );
}

/**
 * Walk the venue cursor instead of allowing one API page to redefine a
 * collection's listed universe. The bound is a transport safety ceiling, not
 * a claim of completeness: callers receive `complete: false` if it is hit.
 */
export async function fetchAllOpenSeaListings(
  slug: string,
  options?: { maxListings?: number; pageSize?: number }
): Promise<{ listings: OpenSeaListing[]; complete: boolean }> {
  const maxListings = Math.min(Math.max(options?.maxListings ?? 10_000, 1), 50_000);
  const pageSize = Math.min(Math.max(options?.pageSize ?? 100, 1), 100);
  const listings: OpenSeaListing[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchOpenSeaListings(slug, Math.min(pageSize, maxListings - listings.length), cursor);
    if (!page) return { listings, complete: false };
    listings.push(...(page.listings ?? []));
    const next = page.next?.trim() || null;
    if (!next) return { listings: listings.slice(0, maxListings), complete: true };
    if (seenCursors.has(next)) return { listings: listings.slice(0, maxListings), complete: false };
    seenCursors.add(next);
    cursor = next;
  } while (listings.length < maxListings);
  return { listings: listings.slice(0, maxListings), complete: false };
}

/** Cached, normalised OpenSea listings. No TTL — see migration 003. */
export const OPENSEA_LISTINGS_KV = "plank:market:opensea-listings-v1";

/**
 * Alias of the shared foreign-listing shape (lib/market/foreign-listings.ts).
 *
 * Kept as a named export because callers and tests already import this name.
 * It is no longer a distinct type: the book merges every venue through one
 * shape, and having each marketplace define its own was what typed mergeBook
 * to OpenSea specifically.
 */
export type NormalisedOpenSeaListing = NormalisedForeignListing;

const ITEM_TYPE_ERC721 = 2;

/**
 * Reduce OpenSea's order payload to the few fields the book needs.
 *
 * Deliberately drops the signature and protocol_data. We do not fulfil these
 * orders — they route through a conduit we do not control and pay no creator
 * royalty — so storing the material needed to sign against them would imply a
 * capability we have decided not to build.
 */
export function normaliseOpenSeaListings(
  listings: OpenSeaListing[]
): NormalisedOpenSeaListing[] {
  const out: NormalisedOpenSeaListing[] = [];
  for (const l of listings) {
    const p = l.protocol_data?.parameters;
    const offer = p?.offer?.[0];
    if (!p?.offerer || !offer || Number(offer.itemType) !== ITEM_TYPE_ERC721) continue;
    if (offer.identifierOrCriteria == null) continue;

    // Price the buyer actually pays: every consideration leg summed, not the
    // seller's take. Quoting the seller's net would understate it.
    let total = BigInt(0);
    for (const c of p.consideration ?? []) {
      try {
        total += BigInt(c.startAmount ?? "0");
      } catch {
        /* skip a leg we cannot read rather than mis-price the whole order */
      }
    }
    if (total <= BigInt(0)) continue;

    out.push({
      tokenId: String(offer.identifierOrCriteria),
      priceWei: total.toString(),
      maker: p.offerer.toLowerCase(),
      // OpenSea's end time is not read here; mergeBook substitutes a
      // far-future sentinel so these never land in "expiring soon".
      expiresAt: null,
      venue: "opensea",
    });
  }
  return out;
}

/** Item page for a token on OpenSea. */
export function openSeaTokenUrl(contract: string, tokenId: string): string {
  return `https://opensea.io/assets/robinhood/${contract.toLowerCase()}/${tokenId}`;
}

export async function readOpenSeaListings(): Promise<NormalisedOpenSeaListing[]> {
  if (!hasDurableKv()) return [];
  try {
    const rows = (await kv.get<NormalisedOpenSeaListing[]>(OPENSEA_LISTINGS_KV)) ?? [];
    // STAMP THE VENUE ON READ, not only on write.
    //
    // This blob is data AT REST, written by whatever version of the
    // normaliser was deployed at the time. `venue` was added to the writer
    // long after rows already existed, so every stored row predating it comes
    // back without the field — and a consumer that assumes it is present
    // throws on real production data while passing every local test, because
    // local KV gets rewritten by the first cron run.
    //
    // That is not hypothetical: it took /api/market/orders down twice. Read
    // is the right layer to fix it — idempotent, needs no migration, and does
    // not wait for a cron pass to repair the book.
    return rows.map((row) => ({ ...row, venue: "opensea" as const }));
  } catch {
    return [];
  }
}

/**
 * Refresh the cached OpenSea book. Keeps the previous copy when OpenSea returns
 * nothing — an outage should shrink the visible market, not empty it.
 */
export async function refreshOpenSeaListings(): Promise<NormalisedOpenSeaListing[]> {
  const page = await fetchAllOpenSeaListings(OPENSEA_COLLECTION_SLUG);
  if (!page.complete || !page.listings.length) return readOpenSeaListings();
  const normalised = normaliseOpenSeaListings(page.listings);
  if (normalised.length === 0) return readOpenSeaListings();
  if (hasDurableKv()) {
    try {
      await kv.set(OPENSEA_LISTINGS_KV, normalised);
    } catch {
      /* next run retries */
    }
  }
  return normalised;
}

/**
 * One-shot reconnaissance, logged rather than stored.
 *
 * The open question for surfacing OpenSea listings is whether we could ever
 * *fulfil* one. Our own orders use no conduit, and OpenSea's mainnet conduit
 * (0x1E00…3c71) is provably absent from chain 4663 — checked with eth_getCode —
 * so they must use different addresses here. Which conduit, and whether it is
 * deployed, decides between a working Buy button and an honest deep link. That
 * cannot be reasoned about; it has to be read off a real order.
 *
 * Everything logged here is public on-chain data: addresses, order types,
 * conduit keys. Never the API key.
 */
export async function probeOpenSeaListingShape(slug: string): Promise<string[]> {
  const out: string[] = [];
  const stats = await fetchOpenSeaCollectionStats(slug);
  if (!stats) {
    out.push("stats: unavailable (no key, or collection slug wrong)");
  } else {
    const t = stats.total ?? {};
    out.push(
      `stats: volume=${t.volume ?? "?"} sales=${t.sales ?? "?"} ` +
        `floor=${t.floor_price ?? "?"} ${t.floor_price_symbol ?? ""} owners=${t.num_owners ?? "?"}`
    );
  }

  const page = await fetchOpenSeaListings(slug, 20);
  const listings = page?.listings ?? [];
  out.push(`listings: ${listings.length} returned`);
  const sample = listings[0];
  if (!sample?.protocol_data?.parameters) {
    out.push("listing shape: no protocol_data to inspect");
    return out;
  }

  const p = sample.protocol_data.parameters;
  out.push(
    `listing shape: chain=${sample.chain} protocol=${sample.protocol_address} ` +
      `orderType=${p.orderType} zone=${p.zone} conduitKey=${p.conduitKey}`
  );
  const recipients = (p.consideration ?? [])
    .map((c) => `${c.recipient}:${c.startAmount}`)
    .join(" ");
  out.push(`consideration: ${recipients || "none"}`);

  const zeroKey = `0x${"0".repeat(64)}`;
  if (p.conduitKey && p.conduitKey !== zeroKey) {
    out.push(
      `conduit: non-zero key — resolve via ConduitController.getConduit() and ` +
        `eth_getCode before assuming fulfilment is possible`
    );
  } else {
    out.push("conduit: zero — Seaport pulls approvals directly, same as our own orders");
  }
  return out;
}
