import { postgresQuery, hasPostgresConfig } from "@/lib/postgres";
import { MARKET_COLLECTIONS } from "@/lib/market/collections";
import { getListings } from "@/lib/market/orders-store";
import { publicError, publicJson, rateLimit } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Cross-collection discovery search: name substring, trait facets (with
 * live counts scoped to the current selection), collection, and price
 * range. Facet counts and rarity come from the offline batch job
 * (scripts/compute-rarity.ts, migration 005_trait_discovery_index.sql) —
 * this route only reads those tables plus the live order book for price.
 */

const MAX_RESULTS = 200;
const MAX_TRAIT_FILTERS = 20;

type TraitFilter = { traitType: string; traitValue: string };

function parseTraitFilters(searchParams: URLSearchParams): TraitFilter[] {
  const out: TraitFilter[] = [];
  for (const raw of searchParams.getAll("trait")) {
    // "Base:Oak"
    const idx = raw.indexOf(":");
    if (idx <= 0) continue;
    const traitType = raw.slice(0, idx).trim();
    const traitValue = raw.slice(idx + 1).trim();
    if (!traitType || !traitValue) continue;
    out.push({ traitType, traitValue });
    if (out.length >= MAX_TRAIT_FILTERS) break;
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  const limited = rateLimit(req, { key: "discover:search", limit: 60, windowMs: 60_000 });
  if (limited) return limited;

  if (!hasPostgresConfig()) {
    return publicJson({
      results: [],
      facets: {},
      total: 0,
      note: "Discovery index unavailable (Postgres not configured).",
    });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const collectionSlug = (url.searchParams.get("collection") || "").trim().slice(0, 64);
  const minEth = url.searchParams.get("minEth");
  const maxEth = url.searchParams.get("maxEth");
  const traitFilters = parseTraitFilters(url.searchParams);

  const collections = collectionSlug
    ? MARKET_COLLECTIONS.filter((c) => c.slug === collectionSlug)
    : MARKET_COLLECTIONS;
  if (collectionSlug && collections.length === 0) {
    return publicJson({ results: [], facets: {}, total: 0, error: "Unknown collection." }, 404);
  }
  const slugs = collections.map((c) => c.slug);
  if (slugs.length === 0) {
    return publicJson({ results: [], facets: {}, total: 0 });
  }

  try {
    // 1) Resolve the token-id set matching current trait filters (AND across
    //    distinct trait_type clauses), scoped to the selected collection(s).
    let matchingTokenIds: Set<string> | null = null; // null = "no trait filter, everything matches"
    for (const filter of traitFilters) {
      const { rows } = await postgresQuery<{ collection: string; token_id: number }>(
        `SELECT collection, token_id FROM collection_token_traits
         WHERE collection = ANY($1) AND trait_type = $2 AND trait_value = $3`,
        [slugs, filter.traitType, filter.traitValue]
      );
      const ids: Set<string> = new Set(rows.map((r) => `${r.collection}:${r.token_id}`));
      const prev: Set<string> | null = matchingTokenIds;
      matchingTokenIds = prev
        ? new Set(Array.from<string>(prev).filter((id: string) => ids.has(id)))
        : ids;
    }

    // 2) Live listings for name/price filtering + result payload. Search by
    //    name substring means the token's display name (RobinWood traits
    //    encode it as the Base trait; fall back to token id).
    // OURS ONLY, DELIBERATELY. Foreign venues (OpenSea, PulpMarket) are merged
    // into the book at request time by lib/market/book.ts and are absent here
    // on purpose: this is a SEARCH surface with price filters, and its result
    // cards are not venue-aware — no badge, no link-out, and a Buy affordance
    // that assumes our own order. Foreign rows would put unbuyable items in
    // front of a buyer with nothing marking them, which is the exact hazard
    // isForeignListing() exists to prevent on /market.
    //
    // Consequence: /discover's floor can read higher than /market's. That is
    // correct, not a bug — see the note in lib/market/trending.ts.
    const allListings = (
      await Promise.all(slugs.map((slug) => getListings(slug)))
    ).flat();

    // Cap at a generous but finite ETH bound before the *1e18 wei conversion —
    // Number.isFinite alone isn't enough: a huge-but-finite ETH value (e.g.
    // 1e300) is still finite pre-multiplication but overflows to Infinity
    // once scaled to wei, and BigInt(Infinity) throws a RangeError that was
    // previously surfacing as an ugly generic 500 instead of a clean 400.
    const MAX_ETH_BOUND = 1e12; // far above any real listing; just a sanity ceiling
    function parseEthBound(raw: string | null): bigint | null {
      if (!raw) return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || Math.abs(n) > MAX_ETH_BOUND) return null;
      return BigInt(Math.round(n * 1e18));
    }
    const minWei = parseEthBound(minEth);
    const maxWei = parseEthBound(maxEth);

    let filtered = allListings.filter((listing) => {
      if (matchingTokenIds && !matchingTokenIds.has(`${listing.collectionSlug}:${listing.tokenId}`)) {
        return false;
      }
      if (minWei !== null || maxWei !== null) {
        try {
          const price = BigInt(listing.priceWei);
          if (minWei !== null && price < minWei) return false;
          if (maxWei !== null && price > maxWei) return false;
        } catch {
          return false;
        }
      }
      return true;
    });

    if (q) {
      const needle = q.toLowerCase();
      // Name search: token id substring always matches; trait-value substring
      // matched across ANY trait_type, not a hardcoded one. RobinWood happens
      // to encode its display name as a "Base" trait, but a second collection
      // may use "Name", may use no name-bearing trait at all, or may just have
      // a different taxonomy — hardcoding trait_type = 'Base' here silently
      // degraded every other collection to token-id-only search (looks like
      // "no results" rather than "unsupported"). Matching any trait_type is
      // the honestly-generic behavior for a cross-collection search: it can
      // over-match a non-name trait too (e.g. "Oak" matching a background
      // color), which is an acceptable trade for not silently breaking.
      const tokenIdsForQuery = new Set(
        filtered
          .filter((l) => l.tokenId.toLowerCase().includes(needle))
          .map((l) => `${l.collectionSlug}:${l.tokenId}`)
      );
      const { rows: nameRows } = await postgresQuery<{ collection: string; token_id: number }>(
        `SELECT collection, token_id FROM collection_token_traits
         WHERE collection = ANY($1) AND trait_value ILIKE $2`,
        [slugs, `%${q}%`]
      );
      for (const row of nameRows) tokenIdsForQuery.add(`${row.collection}:${row.token_id}`);
      filtered = filtered.filter((l) =>
        tokenIdsForQuery.has(`${l.collectionSlug}:${l.tokenId}`)
      );
    }

    const total = filtered.length;
    const results = filtered.slice(0, MAX_RESULTS).map((l) => ({
      id: l.id,
      collectionSlug: l.collectionSlug,
      tokenId: l.tokenId,
      priceWei: l.priceWei,
      imageUrl: l.imageUrl ?? null,
    }));

    // 3) Live facet counts scoped to the current selection: for each
    //    trait_type, count distinct trait_values among tokens that would
    //    remain if that one trait_type's own filter (if any) were relaxed —
    //    i.e. "how many results would each value of this facet leave you
    //    with, given every OTHER currently-applied facet." This is what
    //    makes the panel counts live rather than static collection totals.
    const facets: Record<string, Record<string, number>> = {};
    const { rows: traitRows } = await postgresQuery<{
      collection: string;
      token_id: number;
      trait_type: string;
      trait_value: string;
    }>(
      `SELECT collection, token_id, trait_type, trait_value FROM collection_token_traits
       WHERE collection = ANY($1)`,
      [slugs]
    );
    // Build per-trait-type "matches every OTHER trait_type's filter" sets.
    const perTypeAllowed = new Map<string, Set<string> | null>();
    const uniqueTraitTypes = new Set(traitRows.map((r) => r.trait_type));
    for (const traitType of uniqueTraitTypes) {
      const otherClauses = traitFilters.filter((f) => f.traitType !== traitType);
      let allowed: Set<string> | null = null;
      for (const clause of otherClauses) {
        const ids: Set<string> = new Set(
          traitRows
            .filter((r) => r.trait_type === clause.traitType && r.trait_value === clause.traitValue)
            .map((r) => `${r.collection}:${r.token_id}`)
        );
        const prevAllowed: Set<string> | null = allowed;
        allowed = prevAllowed
          ? new Set(Array.from<string>(prevAllowed).filter((id: string) => ids.has(id)))
          : ids;
      }
      perTypeAllowed.set(traitType, allowed);
    }
    for (const row of traitRows) {
      const allowed = perTypeAllowed.get(row.trait_type) ?? null;
      const key = `${row.collection}:${row.token_id}`;
      if (allowed && !allowed.has(key)) continue;
      const byValue = (facets[row.trait_type] ??= {});
      byValue[row.trait_value] = (byValue[row.trait_value] ?? 0) + 1;
    }

    return publicJson({ results, total, facets, query: { q, collectionSlug, minEth, maxEth, traitFilters } });
  } catch (error) {
    return publicError(error, "Discovery search failed.");
  }
}
