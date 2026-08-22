/**
 * Hand-run single-collection wrapper around
 * lib/market/multichain/rarity-index-runner.ts -- see that file for what
 * this actually does (paginate every token, score rarity, build the trait
 * index, persist both).
 *
 * Usage:
 *   tsx scripts/index-foreign-rarity.ts --chain=base-mainnet --collection=gribbits
 *
 * For every tracked collection at once, see scripts/scaffold-all-collections.ts.
 */
import { hasForeignRarityStore } from "../lib/market/multichain/foreign-rarity-store";
import { indexForeignCollectionRarity } from "../lib/market/multichain/rarity-index-runner";

const chainArg = process.argv.find((a) => a.startsWith("--chain="))?.slice("--chain=".length);
const collectionArg = process.argv.find((a) => a.startsWith("--collection="))?.slice("--collection=".length);

async function main() {
  if (!chainArg || !collectionArg) {
    throw new Error("Usage: tsx scripts/index-foreign-rarity.ts --chain=<chainSlug> --collection=<openSeaSlug>");
  }
  if (!hasForeignRarityStore()) {
    throw new Error("Set PGHOST/PGDATABASE/PGUSER/PGPASSWORD before indexing — this writes where the app reads.");
  }
  const result = await indexForeignCollectionRarity(chainArg, collectionArg);
  console.log(
    `[index-foreign-rarity] wrote ${result.tokensIndexed} tokens + trait index for ${result.collectionSlug} (${result.contractAddress})` +
      (result.partial ? " -- PARTIAL, hit the page ceiling" : "")
  );
}

main()
  .then(async () => {
    const { hasPostgresConfig, postgresPool } = await import("../lib/postgres");
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch((error) => {
    console.error("[index-foreign-rarity] fatal:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
