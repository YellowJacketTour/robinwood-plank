import { fetchNftMetadata } from "@/lib/ipfs";
import { readProof, writeProof } from "@/lib/proof-cache";
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

  // THE PROOF CACHE. A CID is the hash of its own bytes, so one fetch is
  // canonical forever -- for every visitor, every process and every chain that
  // references it.
  //
  // The "immutable" edge header below has always been correct and has never
  // done anything: measured live 2026-09-09, every response carries
  // `cf-cache-status: DYNAMIC` because the zone does not cache query-string
  // URLs. So each visitor paid the full gateway cost, and a burst of ten
  // tokens from ONE directory returned three 200s and seven 500s -- timeouts,
  // not errors, at a median of 5,651 ms against a 5,000 ms limit.
  const cached = await readProof<Awaited<ReturnType<typeof fetchNftMetadata>>>(uri);
  if (cached) return cachedPublicJson(cached, "immutable");

  try {
    const metadata = await fetchNftMetadata(uri);
    // Only self-authenticating URIs are stored; writeProof refuses the rest.
    await writeProof(uri, metadata);
    return cachedPublicJson(metadata, "immutable");
  } catch (error) {
    return publicError(error, "Could not load NFT metadata right now.");
  }
}
