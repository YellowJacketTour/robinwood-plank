import { sanitizeUnknownZeros } from "../lib/market/multichain/store";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

async function main(): Promise<void> {
  const r = await sanitizeUnknownZeros();
  console.log("[heal]", JSON.stringify(r));
}

main()
  .then(async () => {
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error(e);
    try {
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* */
    }
    process.exit(1);
  });
