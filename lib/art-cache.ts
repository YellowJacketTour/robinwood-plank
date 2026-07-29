/**
 * Client-side durable art store: Cache API for image bytes + IndexedDB catalog.
 * Paint path: resolve proxy URL → Cache match → network → put.
 * Keys are same-origin /api/ipfs/image?… so responses are non-opaque.
 */

const CACHE_NAME = "plank-art-v1";
const DB_NAME = "plank-art-db";
const DB_VERSION = 1;
const STORE = "tokens";

export type ArtCatalogRow = {
  tokenId: string;
  imageUrl: string;
  /** Content-ish fingerprint of the proxy URL (for amend). */
  urlKey: string;
  vault?: boolean;
  listed?: boolean;
  owned?: boolean;
  lastArtAt: number;
  lastMetaAt: number;
};

function urlKey(imageUrl: string): string {
  try {
    const u = new URL(imageUrl, "https://plank.love");
    // Prefer cid param if present; else full path+search
    const cid = u.searchParams.get("cid") || u.searchParams.get("uri") || u.search;
    return cid || u.pathname + u.search;
  } catch {
    return imageUrl;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no idb"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("idb open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "tokenId" });
      }
    };
  });
}

export async function putArtCatalog(row: ArtCatalogRow): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(row);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* best-effort */
  }
}

export async function getArtCatalog(tokenId: string): Promise<ArtCatalogRow | null> {
  try {
    const db = await openDb();
    const row = await new Promise<ArtCatalogRow | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(tokenId);
      req.onsuccess = () => resolve((req.result as ArtCatalogRow) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return row;
  } catch {
    return null;
  }
}

export async function listArtCatalog(): Promise<ArtCatalogRow[]> {
  try {
    const db = await openDb();
    const rows = await new Promise<ArtCatalogRow[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as ArtCatalogRow[]) || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  } catch {
    return [];
  }
}

/** Absolute same-origin URL for Cache API keys. */
export function absoluteImageUrl(imageUrl: string): string {
  if (typeof window === "undefined") return imageUrl;
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) return imageUrl;
  if (imageUrl.startsWith("/")) return `${window.location.origin}${imageUrl}`;
  return imageUrl;
}

export async function cacheHasImage(imageUrl: string): Promise<boolean> {
  if (typeof caches === "undefined" || !imageUrl) return false;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(absoluteImageUrl(imageUrl));
    return Boolean(hit);
  } catch {
    return false;
  }
}

/**
 * Ensure image bytes are in Cache API. Returns a displayable URL
 * (same-origin proxy path — browser HTTP cache + Cache API both help).
 */
export async function ensureArtCached(
  tokenId: string,
  imageUrl: string,
  flags?: Partial<Pick<ArtCatalogRow, "vault" | "listed" | "owned">>
): Promise<string> {
  if (!imageUrl) return imageUrl;
  const abs = absoluteImageUrl(imageUrl);
  const key = urlKey(imageUrl);

  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open(CACHE_NAME);
      let res = await cache.match(abs);
      if (!res) {
        // Also try relative key some SW put variants use
        res = await cache.match(imageUrl);
      }
      if (!res || !res.ok) {
        const fetched = await fetch(abs, { credentials: "same-origin" });
        if (fetched.ok && (fetched.headers.get("content-type") || "").startsWith("image/")) {
          // Clone before consuming
          await cache.put(abs, fetched.clone());
          res = fetched;
        }
      }
    }
  } catch {
    /* network / quota — still return imageUrl for normal <img> */
  }

  try {
    const prev = await getArtCatalog(tokenId);
    void putArtCatalog({
      tokenId,
      imageUrl,
      urlKey: key,
      vault: flags?.vault ?? prev?.vault,
      listed: flags?.listed ?? prev?.listed,
      owned: flags?.owned ?? prev?.owned,
      lastArtAt: Date.now(),
      lastMetaAt: Date.now(),
    });
  } catch {
    /* */
  }

  return imageUrl;
}

/**
 * Prefetch a list of {tokenId, imageUrl} into Cache API with concurrency limit.
 * Skips missing URLs. Respects document.hidden and navigator.connection.saveData.
 */
export async function warmArtQueue(
  items: Array<{ tokenId: string; imageUrl: string | null | undefined }>,
  opts?: {
    concurrency?: number;
    flags?: Partial<Pick<ArtCatalogRow, "vault" | "listed" | "owned">>;
    signal?: AbortSignal;
  }
): Promise<{ ok: number; fail: number }> {
  const concurrency = opts?.concurrency ?? 3;
  let ok = 0;
  let fail = 0;
  const queue = items.filter((i) => i.tokenId && i.imageUrl) as Array<{
    tokenId: string;
    imageUrl: string;
  }>;

  let idx = 0;
  async function worker() {
    for (;;) {
      if (opts?.signal?.aborted) return;
      if (typeof document !== "undefined" && document.hidden) {
        await new Promise<void>((resolve) => {
          const onVis = () => {
            if (!document.hidden) {
              document.removeEventListener("visibilitychange", onVis);
              resolve();
            }
          };
          document.addEventListener("visibilitychange", onVis);
          // Cap wait so abort/cancel still works
          setTimeout(() => {
            document.removeEventListener("visibilitychange", onVis);
            resolve();
          }, 30_000);
        });
        if (opts?.signal?.aborted) return;
        continue;
      }
      const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      if (conn?.saveData) return;
      const i = idx++;
      if (i >= queue.length) return;
      try {
        await ensureArtCached(queue[i].tokenId, queue[i].imageUrl, opts?.flags);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()));
  return { ok, fail };
}

export function registerArtServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // Wallet in-app browsers often mishandle SWs (blank pages / stuck caches).
  const ua = navigator.userAgent || "";
  if (/Rabby|MetaMask|CoinbaseWallet|Trust\/|WebView|wv\)/i.test(ua)) return;
  // Register after load so it never blocks first paint.
  const run = () => {
    void navigator.serviceWorker.register("/sw-art.js", { scope: "/" }).catch(() => {
      /* optional */
    });
  };
  if (document.readyState === "complete") run();
  else window.addEventListener("load", run, { once: true });
}
