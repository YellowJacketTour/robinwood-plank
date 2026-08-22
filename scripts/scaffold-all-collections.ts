/**
 * Hand-run wrapper around lib/market/multichain/rarity-index-runner.ts's
 * scaffoldAllTrackedCollections -- see that file for what this actually
 * does (paginate every tracked EVM collection's full token set, score
 * rarity, build the trait index, persist both; Solana out of scope,
 * honestly reported not silently dropped).
 *
 * Also runs automatically via `refresh-market-data.ts --full` as the
 * "scaffold-rarity" step, so a newly-discovered/promoted collection gets
 * this without a manual invocation -- this script is for a deliberate,
 * one-off, watchable run (e.g. after seeding a batch of new collections).
 *
 * Usage:
 *   tsx scripts/scaffold-all-collections.ts [--force] [--freshDays=7] [--delayMs=1500] [--limit=N]
 */
import { hasMultichainStore } from "../lib/market/multichain/store";
import { scaffoldAllTrackedCollections } from "../lib/market/multichain/rarity-index-runner";

const FORCE = process.argv.includes("--force");
const freshDaysArg = process.argv.find((a) => a.startsWith("--freshDays="))?.slice("--freshDays=".length);
const delayArg = process.argv.find((a) => a.startsWith("--delayMs="))?.slice("--delayMs=".length);
const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);

async function main() {
  if (!hasMultichainStore()) {
    throw new Error("Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD before scaffolding — this writes where the app reads.");
  }
  const result = await scaffoldAllTrackedCollections({
    force: FORCE,
    freshDays: freshDaysArg ? Number(freshDaysArg) : undefined,
    delayMs: delayArg ? Number(delayArg) : undefined,
    limit: limitArg ? Number(limitArg) : undefined,
    onProgress: (line) => console.log(`[scaffold] ${line}`),
  });
  console.log(
    `[scaffold] done: ${result.evmInScope} EVM tracked -> ${result.indexed} indexed, ${result.skippedFresh} fresh, ${result.failed} failed; ${result.solanaSkipped} Solana skipped (out of scope)`
  );
}

main()
  .then(async () => {
    const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[scaffold] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
