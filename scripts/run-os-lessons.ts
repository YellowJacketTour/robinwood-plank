/**
 * Apply OpenSea-list lessons on every foreign EVM chain, then stats
 * one chain per process-lifetime so a 429 jail cannot skip the rest.
 *
 *   npx tsx --env-file=.env.local scripts/run-os-lessons.ts
 *   npx tsx --env-file=.env.local scripts/run-os-lessons.ts --stats-only bnb-mainnet
 */
import { spawn } from "node:child_process";
import { runOpenSeaBulkScan } from "../lib/market/multichain/discovery/opensea-bulk-scan";
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry";
import { hasPostgresConfig, postgresPool } from "../lib/postgres";

const argv = process.argv.slice(2);
const statsOnly = argv.includes("--stats-only");
const chains = argv.filter((a) => !a.startsWith("--"));
const targets = FOREIGN_CHAINS.filter(
  (c) => c.openSeaChain && (chains.length === 0 || chains.includes(c.chainSlug))
);

function runStats(chainSlug: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["tsx", "--env-file=.env.local", "scripts/spoke-backfill.ts", "--spoke=evm-opensea-stats", `--chains=${chainSlug}`, "--minutes=3"],
      { cwd: process.cwd(), stdio: "inherit", shell: true }
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`stats ${chainSlug} exit ${code}`))));
  });
}

async function main(): Promise<void> {
  if (!statsOnly) {
    for (const c of targets) {
      const r = await runOpenSeaBulkScan({
        chainSlug: c.chainSlug,
        openSeaChain: c.openSeaChain as string,
        chainId: c.chainId,
        maxPages: c.chainSlug === "eth-mainnet" ? 10 : 5,
      });
      console.log("[bulk]", JSON.stringify(r));
    }
  }
  for (const c of targets) {
    console.log(`[stats] ${c.chainSlug} (fresh process)`);
    await runStats(c.chainSlug).catch((e) => console.error(e));
  }
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
