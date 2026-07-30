import { getCollectionIndex } from "@/lib/market/collection-index";
import { cachedPublicJson } from "@/lib/http-cache";
import { publicError, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The full RobinWood collection dataset in ONE response — every token's
 * name, image, attributes, and rarity — so the gallery's cold start reads
 * this instead of walking tokenURI + IPFS metadata for 1,542 tokens.
 *
 * Collection is fixed and metadata is immutable post-reveal, so this is
 * safe to cache hard at the edge; only ownership (not served here) is
 * dynamic and stays on the existing lazy per-token path.
 */
export async function GET(req: Request) {
  const limited = rateLimit(req, {
    key: "market-collection-index",
    limit: 60,
    windowMs: 60_000,
  });
  if (limited) return limited;

  try {
    const payload = await getCollectionIndex();
    return cachedPublicJson(payload, "rarity", {
      headers: { "X-Collection-Index": "ok" },
    });
  } catch (error) {
    return publicError(error, "Could not load the collection dataset right now.");
  }
}
