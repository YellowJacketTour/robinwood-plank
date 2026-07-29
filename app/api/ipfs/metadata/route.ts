import { fetchNftMetadata } from "@/lib/ipfs";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-side proxy for NFT metadata fetches.
 *
 * Why this exists: `fetchNftMetadata` (lib/ipfs.ts) does a raw `fetch()`
 * against public IPFS gateways. That's fine server-side (Node has no CORS
 * concept), which is why /api/market/token and friends already show real
 * artwork. But every CLIENT-side caller — Gallery, NftViewer, MyInventory —
 * calls the exact same function from the browser, where several of those
 * gateways (nftstorage.link, gateway.pinata.cloud) don't send
 * Access-Control-Allow-Origin, so the browser's CORS check kills the fetch
 * before the response body is ever read — confirmed via real console errors,
 * not assumed. This route does the identical fetch from the server (no CORS
 * restriction applies there) and hands the client back plain same-origin
 * JSON. `fetchNftMetadata` itself now routes through this automatically
 * when running in a browser (see the `typeof window` branch in lib/ipfs.ts)
 * — every existing caller is fixed without touching each one individually.
 */
export async function GET(req: Request) {
  // Sized for a single visitor cold-loading the WHOLE collection on Gallery
  // (~1,500+ tokens), not just a wallet's bag — confirmed live: the old
  // 120/min limit 429'd most of a Gallery page load. This data is public,
  // read-only, and cached client-side after first load, so a generous
  // per-IP ceiling is safe.
  const limited = rateLimit(req, { key: "ipfs-metadata", limit: 2000, windowMs: 60_000 });
  if (limited) return limited;

  const { searchParams } = new URL(req.url);
  const uri = searchParams.get("uri");
  if (!uri) {
    return publicJson({ error: "BAD_URI", message: "uri is required." }, 400);
  }

  try {
    const metadata = await fetchNftMetadata(uri);
    // Content-addressed — safe to cache hard at the edge.
    return cachedPublicJson(metadata, "immutable");
  } catch (error) {
    return publicError(error, "Could not load NFT metadata right now.");
  }
}
