import { ipfsGatewayCandidates } from "@/lib/ipfs";
import { cachedBinary } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side proxy for NFT image BYTES — a distinct problem from the
 * metadata-JSON CORS issue app/api/ipfs/metadata solves.
 *
 * Even after metadata resolves correctly, the browser loading the actual
 * image file directly from an external IPFS gateway (`<img src=
 * "https://gateway.pinata.cloud/...">`) can still fail with
 * `net::ERR_BLOCKED_BY_ORB` (Opaque Response Blocking) — confirmed via real
 * network inspection, not assumed. ORB is a browser security feature
 * distinct from CORS; unlike CORS it isn't fixable by the origin server
 * sending headers we don't control, so the only real fix is to never make
 * the browser load the external URL directly. This route fetches the bytes
 * server-side (racing the same gateway list fetchNftMetadata uses) and
 * streams them back same-origin with a correct, real Content-Type — the
 * browser is now loading from our own domain, where neither CORS nor ORB
 * apply.
 *
 * Images are content-addressed (IPFS) — immutable — so the cache header is
 * aggressive on purpose.
 */
const MAX_BYTES = 15 * 1024 * 1024; // sane ceiling — this collection's art is well under this

/**
 * Fixed width tiers for `?w=` — an allowlist, not a free parameter, so the
 * immutable cache can't be exploded with arbitrary variant keys. Requests
 * round UP to the nearest tier (a 180px grid cell asks for 256).
 */
const WIDTH_TIERS = [256, 512, 1024] as const;

function resolveWidthTier(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const tier of WIDTH_TIERS) {
    if (n <= tier) return tier;
  }
  return WIDTH_TIERS[WIDTH_TIERS.length - 1]!;
}

/**
 * Downscale to `width` and re-encode as WebP. Any failure — sharp missing
 * (e.g. the Cloudflare Worker runtime has no native binary), corrupt bytes,
 * unsupported format — returns null and the caller serves the original
 * bytes; a resize must never turn a working image into a 500.
 * GIFs are excluded upstream so animation survives.
 */
async function tryResize(buf: ArrayBuffer, width: number): Promise<ArrayBuffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(Buffer.from(buf))
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    // Copy into a fresh plain ArrayBuffer. Never hand out.buffer onward:
    // depending on the runtime's Buffer pooling it can be a
    // SharedArrayBuffer, which Response silently stringifies to the literal
    // text "[object SharedArrayBuffer]" — served that way in production.
    const copy = new Uint8Array(out.byteLength);
    copy.set(out);
    return copy.buffer;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  // Same collection-scale sizing as app/api/ipfs/metadata — a Gallery cold
  // load fetches an image per visible/loaded card across ~1,500+ tokens.
  const limited = rateLimit(req, { key: "ipfs-image", limit: 3000, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const uri = searchParams.get("uri");
  if (!uri) {
    return publicJson({ error: "BAD_URI", message: "uri is required." }, 400);
  }
  const widthTier = resolveWidthTier(searchParams.get("w"));

  // SSRF guard: only start from allowlisted public IPFS gateways. Gateways
  // often 30x-redirect to CID subdomains (e.g. bafy….ipfs.dweb.link) — those
  // must be accepted on the FINAL url or every dweb/pinata image 500s.
  const ALLOWED_HOSTS = new Set([
    "gateway.pinata.cloud",
    "ipfs.io",
    "nftstorage.link",
    "w3s.link",
    "dweb.link",
    "4everland.io",
    "cloudflare-ipfs.com",
    // Non-IPFS art CDNs that server-side resolveIpfsUrl() (lib/ipfs.ts) also
    // wraps in this proxy unconditionally for any http(s) image URL -- this
    // route is the one same-origin chokepoint for ALL third-party art, not
    // only IPFS. Confirmed live 2026-08-19: real DB rows already stored as
    // /api/ipfs/image?uri=https://arweave.net/... (Solana/Arweave-hosted
    // art), .../ordinals.com/content/... (Bitcoin ordinal inscriptions),
    // .../static.unisat.io and .../next-cdn.unisat.space (Unisat collection
    // art), and .../we-assets.pinit.io (Bitcoin/Pinit-hosted art) were all
    // 400ing here because their hosts weren't allowlisted -- turning working
    // upstream art into a permanently broken image for every viewer, on
    // every load, forever (unlike a raw-gateway CORS/ORB failure, there's no
    // "load it directly instead" fallback once a value is stored proxied).
    // img.reservoir.tools is deliberately NOT added: confirmed dead
    // (ERR_NAME_NOT_RESOLVED, Reservoir shut down its public infra in 2025 —
    // see defillama-nft.ts and GlobalMarketHub.tsx's own notes), so it's
    // correctly left to fail closed to the placeholder instead of wasting a
    // fetch on a host that can never resolve.
    "arweave.net",
    "ordinals.com",
    "static.unisat.io",
    "next-cdn.unisat.space",
    "we-assets.pinit.io",
  ]);
  // Only the original path-style IPFS gateways require a literal "/ipfs/"
  // segment in the path below. The non-IPFS CDN hosts added above serve
  // content directly off the root path (e.g. arweave.net/<txid>,
  // ordinals.com/content/<id>) and must NOT be held to that IPFS-specific
  // shape.
  const PATH_STYLE_IPFS_HOSTS = new Set([
    "gateway.pinata.cloud",
    "ipfs.io",
    "nftstorage.link",
    "w3s.link",
    "dweb.link",
    "4everland.io",
    "cloudflare-ipfs.com",
  ]);
  function isAllowedHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(h)) return true;
    // CID subdomain gateways after redirect
    if (/\.ipfs\.(dweb\.link|nftstorage\.link|w3s\.link|4everland\.io)$/i.test(h)) return true;
    if (h.endsWith(".ipfs.localhost")) return false;
    return false;
  }
  function isAllowedFetchUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return false;
      if (!isAllowedHost(u.hostname)) return false;
      // Path-style gateways need /ipfs/; subdomain style may not.
      if (PATH_STYLE_IPFS_HOSTS.has(u.hostname.toLowerCase()) && !u.pathname.includes("/ipfs/")) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Expand candidates; if the stored URI is an already-allowed gateway URL
  // that redirects, include rewritten gateway variants from the CID path.
  let candidates = ipfsGatewayCandidates(uri).filter(isAllowedFetchUrl);
  // Prefer Pinata first (collection art resolves reliably there).
  candidates = [
    ...candidates.filter((c) => c.includes("gateway.pinata.cloud")),
    ...candidates.filter((c) => !c.includes("gateway.pinata.cloud")),
  ];
  if (candidates.length === 0) {
    return publicJson({ error: "BAD_URI", message: "Could not resolve this URI." }, 400);
  }

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
        // Follow gateway→CID-subdomain redirects; validate final host below.
        redirect: "follow",
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      // Reject open redirects off our allowlist (SSRF hardening).
      if (res.url && !isAllowedFetchUrl(res.url) && !isAllowedHost(new URL(res.url).hostname)) {
        lastError = new Error(`Blocked redirect host: ${res.url}`);
        continue;
      }
      const contentType = (res.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim()
        .toLowerCase();
      // Some gateways return image/png; charset=… or application/octet-stream for png.
      const looksImage =
        contentType.startsWith("image/") ||
        contentType === "application/octet-stream";
      if (!looksImage) {
        lastError = new Error(`Unexpected content-type: ${contentType}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        lastError = new Error(`Unusable size: ${buf.byteLength}`);
        continue;
      }
      // Sniff PNG/JPEG/WebP/GIF magic if gateway lied with octet-stream.
      const bytes = new Uint8Array(buf.slice(0, 12));
      let ct = contentType.startsWith("image/") ? contentType : "application/octet-stream";
      if (ct === "application/octet-stream") {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) ct = "image/png";
        else if (bytes[0] === 0xff && bytes[1] === 0xd8) ct = "image/jpeg";
        else if (bytes[0] === 0x47 && bytes[1] === 0x49) ct = "image/gif";
        else if (bytes[0] === 0x52 && bytes[1] === 0x49) ct = "image/webp";
        else {
          lastError = new Error("Not an image payload");
          continue;
        }
      }
      // Width-tiered thumbnail: full-res art in a 200px grid cell was tens
      // of MB per page. Skip GIFs (resizing drops animation) and fall back
      // to the original bytes on any resize failure.
      if (widthTier && (ct === "image/png" || ct === "image/jpeg" || ct === "image/webp")) {
        const resized = await tryResize(buf, widthTier);
        if (resized) return cachedBinary(resized, "image/webp", "immutable");
      }
      return cachedBinary(buf, ct, "immutable");
    } catch (error) {
      lastError = error;
    }
  }

  return publicError(lastError, "Could not load this image right now.");
}
