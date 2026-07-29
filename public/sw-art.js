/* Art-only service worker: CacheFirst for same-origin IPFS image proxy.
 * Does not touch navigations or API JSON. */
const CACHE = "plank-art-v1";
const MAX_ENTRIES = 2000;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("plank-art-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isArtRequest(url) {
  try {
    const u = new URL(url);
    return u.origin === self.location.origin && u.pathname === "/api/ipfs/image";
  } catch {
    return false;
  }
}

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const drop = keys.length - MAX_ENTRIES;
  for (let i = 0; i < drop; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !isArtRequest(req.url)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && (res.headers.get("content-type") || "").startsWith("image/")) {
          event.waitUntil(
            (async () => {
              await cache.put(req, res.clone());
              await trimCache(cache);
            })()
          );
        }
        return res;
      } catch (err) {
        // Offline: last resort empty
        return new Response("", { status: 504, statusText: "Art offline" });
      }
    })()
  );
});
