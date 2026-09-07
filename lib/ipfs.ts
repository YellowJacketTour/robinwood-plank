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
 * AUDIT lens 4 #7 / R2 (2): the gateway pool is overridable with
 * `PLANK_IPFS_GATEWAYS` (comma-separated `https://host/ipfs/` prefixes) so
 * production can point bulk hydration at a dedicated/self-hosted gateway
 * (ipfs.io and dweb.link started rate-limiting backend traffic 2026-08-25)
 * without a code change. Server-only: the browser never sees the env var
 * and keeps the public default list (its fetches go through /api/ipfs).
 */
export function activeIpfsGateways(): readonly string[] {
  const raw = typeof process !== "undefined" ? process.env?.PLANK_IPFS_GATEWAYS : undefined;
  if (!raw) return IPFS_GATEWAYS;
  const parsed = raw
    .split(",")
    .map((g) => g.trim())
    .filter((g) => /^https?:\/\/[^/]+\//.test(g))
    .map((g) => (g.endsWith("/") ? g : `${g}/`));
  return parsed.length ? parsed : IPFS_GATEWAYS;
}

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
  // Sibling regional Pinit asset CDNs -- confirmed live 2026-08-24 via
  // direct curl against real stored image_url rows: same shape as
  // we-assets.pinit.io (real 200, real image/png, but NO
  // access-control-allow-origin header), so any in-browser <img>/next/image
  // load ORB-blocks identically. Affected ~140k plank_collection_tokens
  // rows across many collections, not just one -- the root cause behind
  // "almost every collection" showing perpetual "Art pending".
  "na-assets.pinit.io",
  "ap-assets.pinit.io",
  "curved.pinit.io",
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
  return `${url}&w=${width}&cv=3`;
}

/**
 * Return the original media bytes for a single, focused artwork surface.
 * Dense grids deliberately use `withImageWidth`, which turns animated files
 * into a complete first-frame poster. Detail views use this helper so the one
 * selected GIF/WebP may animate without making every off-screen card decode
 * at once. Existing width/cache parameters are removed defensively because
 * projected URLs can already contain a thumbnail variant.
 */
export function withOriginalMedia(url: string | null | undefined): string {
  if (!url || isPoisonedUrlString(url)) return "";
  if (!url.startsWith("/api/ipfs/image?")) return url;
  const [path, rawQuery = ""] = url.split("?", 2);
  const query = new URLSearchParams(rawQuery);
  query.delete("w");
  query.set("cv", "3");
  return `${path}?${query.toString()}`;
}

export function ipfsGatewayCandidates(uri: string): string[] {
  if (!uri) return [];
  if (uri.startsWith("data:")) return [uri];

  // Real gap found and fixed 2026-08-26 (Hash-First Multi-Source Hydration
  // Doctrine, docs/marketplank/GROK-FINDINGS-intelligence-agency-maximal-
  // vision-2026-08-26.md): a real `ar://<txid>` pointer (Arweave's own
  // protocol scheme, real and citable -- arweave.net's own docs) fell
  // through to the raw-IPFS-gateway branch below with no translation,
  // producing garbage URLs like "https://gateway.pinata.cloud/ipfs/ar://<txid>".
  // arweave.net is itself a real, free, keyless HTTP gateway for any
  // Arweave transaction id -- same on-chain-pointer-to-free-gateway shape
  // as ipfs://, just a single real host, not a rotation.
  const arweaveMatch = uri.match(/^ar:\/\/([a-zA-Z0-9_-]+)/i);
  if (arweaveMatch?.[1]) return [`https://arweave.net/${arweaveMatch[1]}`];

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
        ...activeIpfsGateways().map((gateway) => `${gateway}${cidPath}`),
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
  return activeIpfsGateways().map((gateway) => rawGatewayUrl(uri, gateway));
}

export type NftAttribute = {
  trait_type?: string;
  value?: string | number | boolean;
};

export type NftMetadata = {
  name?: string;
  description?: string;
  image?: string;
  animation_url?: string;
  animationUrl?: string;
  media_type?: string;
  attributes?: NftAttribute[];
};

/** A browser-playable original URL for focused video/audio-backed NFT art. */
export function resolveOriginalMediaUrl(uri: string | null | undefined): string {
  if (!uri || isPoisonedUrlString(uri)) return "";
  if (uri.startsWith("data:") || uri.startsWith("blob:")) return uri;
  if (uri.startsWith("/api/ipfs/image?")) {
    const query = new URLSearchParams(uri.split("?", 2)[1] ?? "");
    return query.get("uri") ?? "";
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) return uri;
  return rawGatewayUrl(uri, IPFS_GATEWAYS[0]);
}

function isUsableMetadata(data: NftMetadata | null | undefined): data is NftMetadata {
  if (!data || typeof data !== "object") return false;
  const image = typeof data.image === "string" ? data.image.trim() : "";
  const animation = typeof (data.animation_url ?? data.animationUrl) === "string"
    ? (data.animation_url ?? data.animationUrl)!.trim() : "";
  const attrs = Array.isArray(data.attributes) ? data.attributes : [];
  const name = typeof data.name === "string" ? data.name.trim() : "";
  // Need at least image or traits — bare name is not enough
  return Boolean(image || animation || attrs.length > 0 || name);
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

// ---------------------------------------------------------------------------
// Gateway discipline (AUDIT lens 4 #7, R2 (2)). The old strategy raced three
// gateways per token and the metadata pass ran 25 tokens concurrently: 75
// simultaneous hits on the same public hosts, which is exactly the pattern
// ipfs.io/dweb.link now throttle, and a 429 cost a 30-minute cooldown. Now:
//   * ONE gateway per attempt, chosen by rotating through the pool so load
//     spreads across operators instead of all landing on candidates[0];
//   * a per-host token bucket (~8 requests/second, burst 8) that queues the
//     caller instead of firing -- never a race;
//   * 5 s timeout per attempt, and a retry on a DIFFERENT host;
//   * a host that answers 429/503 is rested for a short window so the next
//     attempt rotates past it.
// ---------------------------------------------------------------------------
export const GATEWAY_RATE_PER_SECOND = 8;
export const GATEWAY_TIMEOUT_MS = 5_000;
const GATEWAY_BURST = 8;
const GATEWAY_REST_MS = 20_000;
const MAX_GATEWAY_ATTEMPTS = 4;

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();
const restedUntil = new Map<string, number>();
let rotation = 0;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

function refill(bucket: Bucket, now: number): void {
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(GATEWAY_BURST, bucket.tokens + elapsed * GATEWAY_RATE_PER_SECOND);
  bucket.updatedAt = now;
}

/**
 * Wait for one request token on `host`. Resolves immediately when the host
 * has capacity; otherwise sleeps until the bucket refills. Exported so the
 * pacing itself is unit-testable without a network.
 */
export async function acquireGatewayToken(host: string, now: number = Date.now()): Promise<void> {
  let bucket = buckets.get(host);
  if (!bucket) {
    bucket = { tokens: GATEWAY_BURST, updatedAt: now };
    buckets.set(host, bucket);
  }
  refill(bucket, now);
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return;
  }
  const waitMs = Math.ceil(((1 - bucket.tokens) / GATEWAY_RATE_PER_SECOND) * 1000);
  // Reserve the token now so concurrent waiters do not all wake and over-spend.
  bucket.tokens -= 1;
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

/** Order the candidate URLs for one fetch: rotated start, rested hosts last. */
export function rotateGatewayCandidates(candidates: string[], now: number = Date.now()): string[] {
  if (candidates.length <= 1) return [...candidates];
  const offset = rotation++ % candidates.length;
  const rotated = candidates.map((_, i) => candidates[(i + offset) % candidates.length]);
  const fresh = rotated.filter((url) => (restedUntil.get(hostOf(url)) ?? 0) <= now);
  const rested = rotated.filter((url) => (restedUntil.get(hostOf(url)) ?? 0) > now);
  return [...fresh, ...rested];
}

/** Test hook: forget every bucket, rest window and rotation offset. */
export function __resetGatewayStateForTests(): void {
  buckets.clear();
  restedUntil.clear();
  rotation = 0;
}

/**
 * Fetch metadata through the gateway discipline above. Never permanently
 * caches failures -- only successful usable metadata.
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

  const candidates = rotateGatewayCandidates(ipfsGatewayCandidates(tokenUri));
  let lastError: unknown;
  const triedHosts = new Set<string>();
  let attempts = 0;
  for (const url of candidates) {
    if (attempts >= MAX_GATEWAY_ATTEMPTS) break;
    const host = hostOf(url);
    // Retry on a DIFFERENT host: a host that just failed is not retried in
    // this call (a single-candidate http(s) URI gets exactly one attempt).
    if (triedHosts.has(host)) continue;
    triedHosts.add(host);
    attempts += 1;
    await acquireGatewayToken(host);
    try {
      const data = await fetchJsonFromUrl(url, GATEWAY_TIMEOUT_MS);
      setCachedMetadata(tokenUri, data);
      return data;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/HTTP (429|503)/.test(message)) restedUntil.set(host, Date.now() + GATEWAY_REST_MS);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to load NFT metadata.");
}
