import { hydrateBitcoinArt } from "../lib/market/multichain/discovery/bitcoin-art-rotator";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

const n = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) ?? "40");

async function main() {
  if (!hasPostgresConfig()) throw new Error("no postgres");
  console.log("[btc-art]", JSON.stringify(await hydrateBitcoinArt(n)));
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
