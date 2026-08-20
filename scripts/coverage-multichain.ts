/**
 * Honest coverage: sourced cells vs registered collections. Dash is not failure.
 */
import { postgresQuery, postgresPool, hasPostgresConfig } from "../lib/postgres";

async function main() {
  if (!hasPostgresConfig()) throw new Error("no postgres");
  const r = await postgresQuery<{
    chain_slug: string;
    n: number;
    floor: number;
    listed: number;
    vol: number;
    holders: number;
    named: number;
  }>(
    `SELECT c.chain_slug,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE s.floor_price_wei IS NOT NULL AND s.floor_price_wei <> '0')::int AS floor,
            COUNT(*) FILTER (WHERE s.listed_count > 0)::int AS listed,
            COUNT(*) FILTER (WHERE s.volume_24h_wei IS NOT NULL AND s.volume_24h_wei <> '0')::int AS vol,
            COUNT(*) FILTER (WHERE s.holder_count > 0)::int AS holders,
            COUNT(*) FILTER (WHERE c.name IS NOT NULL AND c.name NOT ILIKE '0x%')::int AS named
     FROM plank_multichain_collections c
     LEFT JOIN plank_multichain_snapshots s ON s.collection_id = c.id
     GROUP BY 1
     ORDER BY 1`
  );
  console.table(r.rows);
}

main()
  .then(async () => {
    await postgresPool().end().catch(() => {});
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
