/**
 * OpenSea list discovery without Alchemy NFT.
 *   npx tsx --env-file=.env.local scripts/run-opensea-bulk.ts eth-mainnet opt-mainnet arb-mainnet bnb-mainnet
 */
import { runOpenSeaBulkScan } from "../lib/market/multichain/discovery/opensea-bulk-scan";
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

const argv = process.argv.slice(2);
const reset = argv.includes("--reset");
const want = argv.filter((a) => a !== "--reset");
const chains = FOREIGN_CHAINS.filter(
  (c) => c.openSeaChain && (want.length === 0 || want.includes(c.chainSlug))
);

async function main(): Promise<void> {
  if (reset) {
    const { durableKv } = await import("../lib/market/durable-kv");
    for (const c of chains) {
      await durableKv.set(`plank:market:opensea-bulk-scan-cursor-v2:${c.chainSlug}`, null);
      await durableKv.set(`plank:market:opensea-stats-cursor:${c.chainSlug}`, 0);
      console.log(`[reset] cursors ${c.chainSlug}`);
    }
  }
  for (const c of chains) {
    const r = await runOpenSeaBulkScan({
      chainSlug: c.chainSlug,
      openSeaChain: c.openSeaChain as string,
      chainId: c.chainId,
      maxPages: c.chainSlug === "eth-mainnet" ? 10 : 5,
    });
    console.log(JSON.stringify(r));
  }
}

main()
  .then(async () => {
    if (hasPostgresConfig()) await postgresPool().end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      if (hasPostgresConfig()) await postgresPool().end();
    } catch {
      /* */
    }
    process.exit(1);
  });
