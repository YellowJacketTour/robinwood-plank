/**
 * One-time run: seed collection_archival_stats from real, already-hydrated
 * tokens across every tracked collection. See
 * lib/market/multichain/archival-ledger.ts's backfillArchivalStatsFromExistingTokens
 * for why this is needed (ledger table is newer than the real data it counts).
 *
 *   npx tsx --env-file=.env.local scripts/backfill-archival-stats.ts
 */
import { postgresQuery } from "../lib/postgres";
import { backfillArchivalStatsFromExistingTokens } from "../lib/market/multichain/archival-ledger";

async function main() {
  const result = await postgresQuery<{ chain_slug: string; contract_address: string; name: string | null }>(
    `SELECT chain_slug, contract_address, name FROM plank_multichain_collections`
  );
  console.log(`[backfill] ${result.rows.length} tracked collections`);
  let done = 0;
  for (const row of result.rows) {
    try {
      const { realHydratedCount } = await backfillArchivalStatsFromExistingTokens(row.chain_slug, row.contract_address);
      done += 1;
      if (realHydratedCount > 0) {
        console.log(`[backfill] ${row.chain_slug}:${row.contract_address} (${row.name ?? "?"}) -> ${realHydratedCount} real hydrated tokens`);
      }
    } catch (error) {
      console.error(`[backfill] FAILED ${row.chain_slug}:${row.contract_address}`, error instanceof Error ? error.message : error);
    }
  }
  console.log(`[backfill] done: ${done}/${result.rows.length}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[backfill] fatal", error);
  process.exit(1);
});
