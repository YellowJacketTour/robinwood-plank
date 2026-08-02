import { getCollection } from "@/lib/market/collections";
import { getTraitIndex } from "@/lib/market/trait-index";
import { getRaritySnapshot } from "@/lib/market/rarity-snapshot";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Trait → token-id index for a collection, used to drive trait-scoped bids
 * ("bid on the cheapest Holographic RobinWood").
 *
 * The scan is server-side, background, and cached hard (metadata is
 * immutable — see lib/market/trait-index.ts). While the index is still
 * building, the response says so and the UI must not offer trait bids yet —
 * the POST /api/market/orders trait path independently refuses them until
 * the index is complete (fail closed).
 */
export async function GET(req: Request) {
  try {
    const limited = rateLimit(req, { key: "market-traits-get", limit: 60, windowMs: 60_000 });
    if (limited) return limited;

    const { searchParams } = new URL(req.url);
    const slug = searchParams.get("collection") ?? "";
    const collection = getCollection(slug);
    if (!collection) {
      return publicJson(
        { error: "BAD_COLLECTION", message: "Unknown or unlisted collection." },
        400
      );
    }

    const { index, complete, building } = await getTraitIndex(collection);
    let rankings: Record<string, number> | null = null;
    if (complete) {
      try {
        const rarity = await getRaritySnapshot();
        rankings = {};
        for (const [tokenId, item] of rarity.byTokenId) {
          rankings[String(tokenId)] = item.rank;
        }
      } catch {
        // Trait and rarity criteria remain available if rank data is cold.
      }
    }
    return publicJson({
      collection: collection.slug,
      complete,
      building,
      totalSupply: index?.totalSupply ?? null,
      scanned: index?.scanned ?? 0,
      // Trait sets are only served once COMPLETE — a partial set would let the
      // UI build a bid whose snapshot under-covers the trait.
      traits: complete && index ? index.traits : null,
      rankings,
    });
  } catch (err) {
    return publicError(err, "Unexpected error reading trait index.");
  }
}
