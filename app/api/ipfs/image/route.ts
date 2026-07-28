import { ipfsGatewayCandidates } from "@/lib/ipfs";
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

  const candidates = ipfsGatewayCandidates(uri);
  if (candidates.length === 0) {
    return publicJson({ error: "BAD_URI", message: "Could not resolve this URI." }, 400);
  }

  let lastError: unknown = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      if (!contentType.startsWith("image/")) {
        // A gateway returning HTML/JSON where an image was expected (error
        // page, redirect page) is exactly the shape that trips ORB when
        // loaded directly — reject it here too rather than pass it through.
        lastError = new Error(`Unexpected content-type: ${contentType}`);
        continue;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        lastError = new Error(`Unusable size: ${buf.byteLength}`);
        continue;
      }
      return new Response(buf, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (error) {
      lastError = error;
    }
  }

  return publicError(lastError, "Could not load this image right now.");
}
