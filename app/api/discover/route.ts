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
    const allListings = (
      await Promise.all(slugs.map((slug) => getListings(slug)))
    ).flat();

    const min = minEth ? Number(minEth) : null;
    const max = maxEth ? Number(maxEth) : null;
    const minWei = min !== null && Number.isFinite(min) ? BigInt(Math.round(min * 1e18)) : null;
    const maxWei = max !== null && Number.isFinite(max) ? BigInt(Math.round(max * 1e18)) : null;

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
      // Name search: token id substring always matches; trait-derived name
      // (Base value) matched via the traits table for collections that have one.
      const tokenIdsForQuery = new Set(
        filtered
          .filter((l) => l.tokenId.toLowerCase().includes(needle))
          .map((l) => `${l.collectionSlug}:${l.tokenId}`)
      );
      const { rows: nameRows } = await postgresQuery<{ collection: string; token_id: number }>(
        `SELECT collection, token_id FROM collection_token_traits
         WHERE collection = ANY($1) AND trait_type = 'Base' AND trait_value ILIKE $2`,
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
