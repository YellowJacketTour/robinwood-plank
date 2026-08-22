import { hydrateAllCollectionArt } from "../lib/market/multichain/discovery/hydrate-all-collection-art";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

async function main() {
  if (!hasPostgresConfig()) throw new Error("no postgres");
  console.log("[all-art]", JSON.stringify(await hydrateAllCollectionArt(), null, 2));
}

main()
  .then(async () => {
    await postgresPool().end().catch(() => {});
    process.exit(0);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
