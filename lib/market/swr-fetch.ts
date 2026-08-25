/**
 * Shared client-side stale-while-revalidate cache for public market GETs.
 *
 * Multiple Instant Swap panels (fence, odds, chart, trades, dashboard) all
 * hit the same endpoints — without this, a cold tab fires 4–6 identical
 * requests. With it: first caller fetches, everyone else shares inflight +
 * memory, and soft-expired hits return instantly while a background refresh
 * updates the store.
 */

type Entry = {
  at: number;
  data: unknown;
  inflight: Promise<unknown> | null;
};

const memory = new Map<string, Entry>();

const DEFAULT_TTL_MS = 12_000;
const DEFAULT_SWR_MS = 90_000;

function sessionGet(key: string): { at: number; data: unknown } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`plank-swr:${key}`);
    if (!raw) return null;
    return JSON.parse(raw) as { at: number; data: unknown };
  } catch {
    return null;
  }
}

function sessionSet(key: string, data: unknown) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`plank-swr:${key}`, JSON.stringify({ at: Date.now(), data }));
  } catch {
    /* quota */
  }
}

// --- IndexedDB persistence -------------------------------------------------
// sessionStorage only survives the tab's lifetime. IndexedDB additionally
// survives full browser restarts, so a repeat visit to the same collection
// (even after quitting the browser) gets an instant, real first paint from
// the last-known-good response before any network round-trip completes —
// classic persisted stale-while-revalidate, not a GPU/network speed claim.
const IDB_DB_NAME = "plank-swr-cache";
const IDB_STORE = "kv";
const IDB_MAX_AGE_MS = 24 * 60 * 60 * 1000; // stale ceiling for instant paint only

let idbOpenPromise: Promise<IDBDatabase | null> | null = null;

function idbOpen(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  if (idbOpenPromise) return idbOpenPromise;
  idbOpenPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return idbOpenPromise;
}

async function idbGet(key: string): Promise<{ at: number; data: unknown } | null> {
  const db = await idbOpen();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as { at: number; data: unknown }) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key: string, data: unknown): Promise<void> {
  const db = await idbOpen();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ at: Date.now(), data }, key);
  } catch {
    /* quota / private mode */
  }
}

export type SwrOptions = {
  /** Serve from memory without network when younger than this. */
  ttlMs?: number;
  /** After ttl, still serve stale and revalidate until this age. */
  swrMs?: number;
  /** Persist last good payload in sessionStorage for instant reload paint. */
  session?: boolean;
  /**
   * If set, a successful response that fails this check is NOT written to
   * memory/session (so a transient empty vault/held payload can't poison
   * the cache for 2 minutes while stats still say 57 held).
   */
  isGood?: (data: unknown) => boolean;
};

/**
 * Fetch JSON with shared SWR semantics. `url` is the cache key (include query).
 */
export async function swrJson<T>(url: string, opts: SwrOptions = {}): Promise<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const swrMs = opts.swrMs ?? DEFAULT_SWR_MS;
  const useSession = opts.session !== false;
  const isGood = opts.isGood;
  const now = Date.now();

  let entry = memory.get(url);
  // Drop poisoned empty entries so we don't keep serving "0 held".
  if (entry && isGood && entry.data !== undefined && !isGood(entry.data)) {
    memory.delete(url);
    entry = undefined;
  }

  if (entry && now - entry.at < ttlMs) {
    return entry.data as T;
  }

  // Soft-stale: return immediately, refresh in background.
  if (entry && now - entry.at < swrMs) {
    if (!entry.inflight) {
      entry.inflight = fetchAndStore(url, useSession, isGood).finally(() => {
        const e = memory.get(url);
        if (e) e.inflight = null;
      });
    }
    return entry.data as T;
  }

  // Cold memory — try session for instant paint, then network.
  if (!entry && useSession) {
    const sess = sessionGet(url);
    if (sess && now - sess.at < swrMs && (!isGood || isGood(sess.data))) {
      entry = { at: sess.at, data: sess.data, inflight: null };
      memory.set(url, entry);
      if (now - sess.at >= ttlMs) {
        entry.inflight = fetchAndStore(url, useSession, isGood).finally(() => {
          const e = memory.get(url);
          if (e) e.inflight = null;
        });
      }
      return sess.data as T;
    }
  }

  // Cold memory + no fresh session entry (new tab after a browser restart) —
  // fall back to IndexedDB. Allowed to be older than swrMs since this is a
  // last-known-good instant paint, not a "fresh enough to skip refetch"
  // claim; a background refresh always still fires.
  if (!entry && useSession) {
    const idb = await idbGet(url);
    if (idb && now - idb.at < IDB_MAX_AGE_MS && (!isGood || isGood(idb.data))) {
      entry = { at: idb.at, data: idb.data, inflight: null };
      memory.set(url, entry);
      entry.inflight = fetchAndStore(url, useSession, isGood).finally(() => {
        const e = memory.get(url);
        if (e) e.inflight = null;
      });
      return idb.data as T;
    }
  }

  if (entry?.inflight) return entry.inflight as Promise<T>;

  const inflight = fetchAndStore(url, useSession, isGood);
  memory.set(url, { at: entry?.at ?? 0, data: entry?.data, inflight });
  try {
    return (await inflight) as T;
  } finally {
    const e = memory.get(url);
    if (e) e.inflight = null;
  }
}

async function fetchAndStore(
  url: string,
  useSession: boolean,
  isGood?: (data: unknown) => boolean
): Promise<unknown> {
  const res = await fetch(url, {
    // Bypass shared HTTP caches for live inventory — an empty CDN edge
    // response was painting "nothing held" for minutes while the vault had 57.
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    // BUG FIXED 2026-08-25: a transient HTTP error (a 429 from our own
    // per-route rate limiter, a momentary 5xx) used to throw unconditionally,
    // which surfaced as an uncaught runtime error/crash overlay for any
    // caller that awaited this without its own catch -- same
    // transient-failure-must-not-discard-cache discipline already applied
    // to the singleflight cache. Fall back to the last-good cached value
    // when one exists; only throw when there's truly nothing to serve.
    const prev = memory.get(url);
    if (prev?.data !== undefined) return prev.data;
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  const data = await res.json();
  // Never poison SWR with a "bad" payload (e.g. empty held list from a blip).
  if (isGood && !isGood(data)) {
    const prev = memory.get(url);
    if (prev?.data !== undefined && isGood(prev.data)) return prev.data;
    throw new Error(`Unusable response for ${url}`);
  }
  memory.set(url, { at: Date.now(), data, inflight: null });
  if (useSession) {
    sessionSet(url, data);
    void idbSet(url, data);
  }
  return data;
}

/** Prefetch without throwing — used on market mount for warm Instant Swap. */
export function prefetchJson(url: string, opts?: SwrOptions): void {
  void swrJson(url, opts).catch(() => {});
}

export function invalidateSwr(urlPrefix?: string): void {
  if (!urlPrefix) {
    memory.clear();
  } else {
    for (const key of memory.keys()) {
      if (key.startsWith(urlPrefix)) memory.delete(key);
    }
  }
  if (typeof window === "undefined") return;
  try {
    const drop: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (!k?.startsWith("plank-swr:")) continue;
      if (!urlPrefix || k.includes(urlPrefix)) drop.push(k);
    }
    for (const k of drop) sessionStorage.removeItem(k);
  } catch {
    /* private mode / quota */
  }
  void idbInvalidate(urlPrefix);
}

async function idbInvalidate(urlPrefix?: string): Promise<void> {
  const db = await idbOpen();
  if (!db) return;
  try {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    if (!urlPrefix) {
      store.clear();
      return;
    }
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result) {
        if (typeof key === "string" && key.includes(urlPrefix)) store.delete(key);
      }
    };
  } catch {
    /* private mode / quota */
  }
}
