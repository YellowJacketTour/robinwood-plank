import { backfillUnisatCollectionArt } from "../lib/market/multichain/adapters/unisat-collections";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

const pagesArg = process.argv.find((a) => a.startsWith("--pages="));
const pages = pagesArg ? Number(pagesArg.slice("--pages=".length)) : 15;

async function main() {
  if (!hasPostgresConfig()) throw new Error("no postgres");
  const r = await backfillUnisatCollectionArt(pages);
  console.log("[unisat-art]", JSON.stringify(r));
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
