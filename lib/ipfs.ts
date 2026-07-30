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
 * Ask the image proxy for a width-tiered thumbnail (256 / 512 / 1024 — the
 * route rounds up and ignores anything else). Only applies to our own
 * /api/ipfs/image URLs; data: URIs, static assets, and raw URLs pass
 * through untouched. Full-res art in a ~200px grid cell was the single
 * biggest transfer cost on /market.
 */
export function withImageWidth(url: string | null | undefined, width: number): string {
  if (!url) return url ?? "";
  if (!url.startsWith("/api/ipfs/image?")) return url;
  return `${url}&w=${width}`;
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
