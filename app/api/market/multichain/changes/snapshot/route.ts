import { NextRequest } from "next/server";
import { postgresQuery } from "@/lib/postgres";
import { rateLimit } from "@/lib/security";
import { parseScopes } from "@/lib/market/multichain/edge/change-protocol";
import { normalizeContractAddress } from "@/lib/market/multichain/collection-key";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, { key: "market-change-snapshot", limit: 60, windowMs: 60_000 });
  if (limited) return limited;
  let scopes;
  try { scopes = parseScopes(JSON.parse(req.nextUrl.searchParams.get("scopes") ?? "null")); } catch { scopes = null; }
  if (!scopes?.length) return Response.json({ error: "Supply 1–64 collection scopes." }, { status: 400 });
  // Stored projections only. No provider calls, discovery, or jobs on this path.
  const result = await postgresQuery(`
    WITH wanted AS (SELECT DISTINCT * FROM UNNEST($1::text[], $2::text[]) AS w(chain, collection))
    SELECT c.chain_slug AS "chainSlug", c.contract_address AS "contractAddress",
      c.name, c.image_url AS "imageUrl", s.floor_price_wei::text AS "floorPriceWei",
      s.floor_price_currency AS "floorPriceCurrency", s.listed_count AS "listedCount",
      s.total_supply::float8 AS "totalSupply", s.holder_count AS "holderCount", s.synced_at AS "syncedAt"
    FROM wanted w JOIN plank_multichain_collections c ON c.chain_slug = w.chain AND c.contract_address = w.collection
    LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id`,
  [scopes.map((s) => s.chainSlug), scopes.map((s) => normalizeContractAddress(s.chainSlug, s.collectionKey))]);
  return Response.json({ collections: result.rows, requested: scopes.length, returned: result.rows.length },
    { headers: { "Cache-Control": "no-store" } });
}
