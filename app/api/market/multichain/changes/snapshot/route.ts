import { NextRequest } from "next/server";
import { postgresQuery } from "@/lib/postgres";
import { rateLimit } from "@/lib/security";
import { parseScopes } from "@/lib/market/multichain/edge/change-protocol";
import { NFT_CONTRACT_ADDRESS } from "@/lib/mint-contract";
import { salesStatsFromLedger } from "@/lib/market/chain-events";
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
      s.volume_24h_wei::text AS "volume24hWei", s.sales_24h AS "sales24h",
      s.volume_7d_wei::text AS "volume7dWei", s.sales_7d AS "sales7d",
      s.volume_30d_wei::text AS "volume30dWei", s.sales_30d AS "sales30d",
      s.floor_change_pct AS "floorChangePct", s.floor_observed_at AS "floorObservedAt",
      s.total_supply::float8 AS "totalSupply", s.holder_count AS "holderCount", s.synced_at AS "syncedAt"
    FROM wanted w JOIN plank_multichain_collections c ON c.chain_slug = w.chain AND c.contract_address = w.collection
    LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id`,
  [scopes.map((s) => s.chainSlug), scopes.map((s) => normalizeContractAddress(s.chainSlug, s.collectionKey))]);
  // The native book owns its floor, inventory, supply and owner projection.
  // A generic discovery snapshot must never erase that independent source.
  // Its rolling sales come from the same permanent ledger as the native page.
  const collections = await Promise.all(result.rows.map(async (row) => {
    if (row.chainSlug !== "robinhood" || row.contractAddress !== NFT_CONTRACT_ADDRESS.toLowerCase()) return row;
    const stats = await salesStatsFromLedger();
    return { chainSlug: row.chainSlug, contractAddress: row.contractAddress,
      sales24h: stats.sales24h, volume24hWei: stats.volume24hWei,
      sales7d: stats.sales7d, volume7dWei: stats.volume7dWei,
      sales30d: stats.sales30d, volume30dWei: stats.volume30dWei };
  }));
  return Response.json({ collections, requested: scopes.length, returned: collections.length },
    { headers: { "Cache-Control": "no-store" } });
}
