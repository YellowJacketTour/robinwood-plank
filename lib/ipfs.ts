import { getCachedMetadata, setCachedMetadata } from "@/lib/nft-cache";

/**
 * Public IPFS gateways tried for metadata and images.
 * Pinata first — this collection's art CID resolves reliably there;
 * ipfs.io / cloudflare / dweb often timeout or 504 on the image folder.
 */
export const IPFS_GATEWAYS = [
  "https://gateway.pinata.cloud/ipfs/",
  "https://ipfs.io/ipfs/",
  "https://nftstorage.link/ipfs/",
  "https://w3s.link/ipfs/",
  "https://dweb.link/ipfs/",
  "https://4everland.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
] as const;

/**
 * Convert ipfs:// CIDs (and nested paths with spaces) into a browser-loadable
 * image URL. Path segments are encoded so filenames like "Is This Art4.png"
 * work.
 *
 * Returns a SAME-ORIGIN proxy path (/api/ipfs/image), not the raw external
 * gateway URL. Reason, confirmed by direct network inspection, not assumed:
 * loading an external IPFS gateway URL straight into `<img src>` can fail
 * with `net::ERR_BLOCKED_BY_ORB` (Opaque Response Blocking) — a browser
 * security feature distinct from CORS, and unlike CORS not something a
 * response header can fix. The proxy (app/api/ipfs/image) fetches the bytes
 * server-side, where neither CORS nor ORB apply, and streams them back from
 * our own domain. No caller of this function needs the raw external URL for
 * anything other than eventually rendering an image, so this is safe to
 * change universally rather than patch call sites one at a time.
 */
/** Raw (non-proxied) gateway URL for an ipfs://-style URI. Used both by
 * resolveIpfsUrl (which wraps the result in our proxy) and by
 * ipfsGatewayCandidates (which must NOT wrap it — see that function). */
function rawGatewayUrl(uri: string, gateway: string): string {
  let path = uri.startsWith("ipfs://")
    ? uri.slice("ipfs://".length)
    : uri.startsWith("/ipfs/")
      ? uri.slice("/ipfs/".length)
      : uri;

  // ipfs://ipfs/CID → CID
  if (path.startsWith("ipfs/")) path = path.slice(5);

  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `${gateway}${encoded}`;
}

/** Hosts that fail in-browser with ORB/CORS when loaded as raw <img>/next/image. Same-origin proxy only. */
export const ORB_PRONE_ART_HOSTS = new Set([
  "ordinals.com",
  "www.ordinals.com",
  "static.unisat.io",
  "next-cdn.unisat.space",
  "we-assets.pinit.io",
  "coin-images.coingecko.com",
  "creator-hub-prod.s3.us-east-2.amazonaws.com",
  "turbo.ordinalswallet.com",
  "media.ordinalswallet.com",
  "cdn.ordinalswallet.com",
  "ord-mirror.magiceden.dev",
]);

/**
 * True only for URLs the /api/ipfs/image proxy's own SSRF allowlist will
 * actually accept (mirrors app/api/ipfs/image/route.ts's ALLOWED_HOSTS).
 * Used client-side to decide whether a raw http(s) URL is safe to route
 * through resolveIpfsUrl: wrapping an arbitrary URL (e.g. an OpenSea/Alchemy
 * CDN image on i.seadn.io, which loads fine directly) would just get a 400
 * back from the proxy and turn a working image into a broken one. Only
 * known public IPFS gateway hosts -- the ones actually seen to trip
 * ERR_BLOCKED_BY_RESPONSE/ORB in a real browser -- get proxied; everything
 * else is left as-is, unproxied, exactly like it renders today.
 */
export function isIpfsGatewayUrl(uri: string): boolean {
  if (!uri) return false;
  try {
    const u = new URL(uri);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    const gatewayHosts = IPFS_GATEWAYS.map((g) => new URL(g).hostname.toLowerCase());
    if (gatewayHosts.includes(host)) return true;
    // CID subdomain gateways, e.g. bafy....ipfs.dweb.link
    if (/\.ipfs\.(dweb\.link|nftstorage\.link|w3s\.link|4everland\.io)$/i.test(host)) return true;
    if (ORB_PRONE_ART_HOSTS.has(host)) return true;
    return false;
  } catch {
    return false;
  }
}

export function resolveIpfsUrl(
  uri: string,
  gateway: string = IPFS_GATEWAYS[0],
): string {
  if (!uri) return "";
  // Inline data URIs need no fetch at all — never proxy these.
  if (uri.startsWith("data:")) return uri;
  // Already one of our own routes (e.g. re-resolving an already-resolved
  // value) — never double-wrap.
  if (uri.startsWith("/api/ipfs/")) return uri;

  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return `/api/ipfs/image?uri=${encodeURIComponent(uri)}`;
  }

  const target = rawGatewayUrl(uri, gateway);
  return `/api/ipfs/image?uri=${encodeURIComponent(target)}`;
}

/**
 * Ask the image proxy for a width-tiered thumbnail (256 / 512 / 1024 / 2048 — the
 * route rounds up and ignores anything else). Hero uses 2048. Only applies to our own
 * /api/ipfs/image URLs; data: URIs, static assets, and raw URLs pass
 * through untouched. Full-res art in a ~200px grid cell was the single
 * biggest transfer cost on /market.
 */
/**
 * Real, confirmed upstream data bug (see alchemy-nft.ts's own
 * cleanMetadataString for the live-verified source): some third-party NFT
 * metadata carries the LITERAL 4-character string "null" instead of a real
 * null for an image field. alchemy-nft.ts now sanitizes this at write time
 * for newly-discovered collections, but this app already has real rows in
 * Postgres from BEFORE that fix, and every OTHER image field this app
 * reads (listing art, per-token art from OpenSea/Alchemy/Magic Eden
 * responses) is a second real place the same poison can appear. Treated
 * here, at the one shared "prepare a URL to hand to <Image>" chokepoint,
 * so every caller's own `|| fallback` logic works correctly against it
 * instead of every call site needing its own guard.
 */
function isPoisonedUrlString(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed === "" || trimmed === "null" || trimmed === "undefined";
}

export function withImageWidth(url: string | null | undefined, width: number): string {
  if (!url || isPoisonedUrlString(url)) return "";
  if (!url.startsWith("/api/ipfs/image?")) return url;
  // cv is a cache generation: responses are cached immutable for a year, so
  // when a resize bug ships broken bytes (cv=2 busted the SharedArrayBuffer
  // incident), bumping it re-keys every client cache at once.
  return `${url}&w=${width}&cv=2`;
}

export function ipfsGatewayCandidates(uri: string): string[] {
  if (!uri) return [];
  if (uri.startsWith("data:")) return [uri];

  // Already an http(s) URL — still try gateway rewrites if it looks like /ipfs/.
  // These stay RAW external URLs on purpose: this function is also called
  // server-side by app/api/ipfs/image/route.ts to get the real gateway
  // candidates to fetch — wrapping them in the proxy here would make that
  // route recursively call itself. Client-side callers that render an <img>
  // directly from these candidates (NftViewer's fallback cascade) are
  // responsible for proxying at the point of use.
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    const match = uri.match(/\/ipfs\/(.+)$/i);
    if (match) {
      const cidPath = match[1];
      return [
        uri,
        ...IPFS_GATEWAYS.map((gateway) => `${gateway}${cidPath}`),
      ];
    }
    return [uri];
  }

  // Raw ipfs:// (or bare CID/path) input — build raw external candidates
  // directly via rawGatewayUrl, NOT resolveIpfsUrl: this function is also
  // called server-side (fetchNftMetadata's gateway race, and
  // app/api/ipfs/image/route.ts itself) where a relative /api/ipfs/... path
  // isn't a fetchable URL at all — Node's fetch() has no page origin to
  // resolve it against.
  return IPFS_GATEWAYS.map((gateway) => rawGatewayUrl(uri, gateway));
}

export type NftAttribute = {
  trait_type?: string;
  value?: string | number | boolean;
};

export type NftMetadata = {
  name?: string;
  description?: string;
  image?: string;
  attributes?: NftAttribute[];
};

function isUsableMetadata(data: NftMetadata | null | undefined): data is NftMetadata {
  if (!data || typeof data !== "object") return false;
  const image = typeof data.image === "string" ? data.image.trim() : "";
  const attrs = Array.isArray(data.attributes) ? data.attributes : [];
  const name = typeof data.name === "string" ? data.name.trim() : "";
  // Need at least image or traits — bare name is not enough
  return Boolean(image || attrs.length > 0 || name);
}

async function fetchJsonFromUrl(
  url: string,
  timeoutMs: number,
): Promise<NftMetadata> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
    headers: { Accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = (await response.json()) as NftMetadata;
  if (!isUsableMetadata(data)) {
    throw new Error("Empty metadata payload");
  }
  return data;
}

/**
 * In the browser, several public IPFS gateways (nftstorage.link,
 * gateway.pinata.cloud) don't send Access-Control-Allow-Origin, so a direct
 * `fetch()` from client code is killed by CORS before the response body is
 * ever read — confirmed via real console errors, not assumed. Server-side
 * (Node) has no CORS concept, so the identical fetch works fine there; that
 * asymmetry is exactly why API routes already showed real artwork while
 * Gallery/NftViewer/MyInventory (client components) did not. Routing the
 * browser path through our own same-origin proxy (app/api/ipfs/metadata)
 * fixes every client caller at once without touching each one.
 */
async function fetchViaProxy(tokenUri: string): Promise<NftMetadata> {
  const res = await fetch(`/api/ipfs/metadata?uri=${encodeURIComponent(tokenUri)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as NftMetadata;
  if (!isUsableMetadata(data)) {
    throw new Error("Empty metadata payload");
  }
  return data;
}

/**
 * Race the first N gateways, then walk the rest serially.
 * Never permanently cache failures — only successful usable metadata.
 */
export async function fetchNftMetadata(
  tokenUri: string,
  options?: { force?: boolean },
): Promise<NftMetadata> {
  if (!tokenUri) throw new Error("Empty tokenURI");

  if (!options?.force) {
    const cached = getCachedMetadata(tokenUri);
    if (cached && isUsableMetadata(cached)) {
      // Prefer cache hits that include image; otherwise re-fetch
      if (cached.image?.trim() || (cached.attributes?.length ?? 0) > 0) {
        return cached;
      }
    }
  }

  if (typeof window !== "undefined") {
    const data = await fetchViaProxy(tokenUri);
    setCachedMetadata(tokenUri, data);
    return data;
  }

  const candidates = ipfsGatewayCandidates(tokenUri);
  let lastError: unknown;

  // Race first 3 gateways for speed (newest mints need this)
  const raceN = Math.min(3, candidates.length);
  if (raceN > 0) {
    try {
      const data = await Promise.any(
        candidates.slice(0, raceN).map((url) => fetchJsonFromUrl(url, 8_000)),
      );
      setCachedMetadata(tokenUri, data);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  // Remaining gateways serially with slightly longer timeout
  for (const url of candidates.slice(raceN)) {
    try {
      const data = await fetchJsonFromUrl(url, 12_000);
      setCachedMetadata(tokenUri, data);
      return data;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to load NFT metadata.");
}
