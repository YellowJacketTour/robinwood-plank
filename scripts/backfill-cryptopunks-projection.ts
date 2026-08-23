/**
 * One-off: run syncCryptoPunksTraits() to backfill plank_collection_tokens
 * with rarity_rank/rarity_tier for CryptoPunks now that the adapter writes
 * that projection (see native-market-adapters/cryptopunks.ts). Safe to
 * re-run; it's the same idempotent sync the cron step already calls.
 */
import { syncCryptoPunksTraits } from "../lib/market/multichain/native-market-adapters/cryptopunks";

async function main() {
  const result = await syncCryptoPunksTraits();
  console.log(`[backfill-cryptopunks-projection] indexed ${result.indexed} tokens, ${result.traits} trait values`);
}

main()
  .then(async () => {
    const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[backfill-cryptopunks-projection] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
