import { runOpenSeaStatsSync } from "../lib/market/multichain/discovery/opensea-stats.ts";
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry.ts";
import { readSourceBudget } from "../lib/market/multichain/discovery/source-budget.ts";

// Bounded pass driving the real OpenSea-stats floor/24h-volume fallback
// (opensea-stats.ts) across every EVM chain with an OpenSea orderbook --
// the fix for the Floor/24h Volume cells left empty by Alchemy's own
// still-unrecovered NFT-API 429, confirmed live 2026-08-20. Chains with
// no OpenSea orderbook (zkSync, openSeaChain: null) are skipped, same as
// every other OpenSea-backed scan in this app.
const defaultChains = FOREIGN_CHAINS.filter((c) => c.openSeaChain).map((c) => c.chainSlug);
const argv = process.argv.slice(2);
const minutesArg = argv.find((a) => a.startsWith("--minutes="));
const batchArg = argv.find((a) => a.startsWith("--batch="));
const chainArgs = argv.filter((a) => !a.startsWith("--"));
const chains = chainArgs.length > 0 ? chainArgs : defaultChains;
const minutes = minutesArg ? Number(minutesArg.slice("--minutes=".length)) : 4;
const batch = batchArg ? Number(batchArg.slice("--batch=".length)) : 20;
const started = Date.now();
let round = 0;
const totals = Object.fromEntries(chains.map((c) => [c, 0]));
while (Date.now() - started < 1000 * 60 * minutes) {
  round += 1;
  let progressed = false;
  for (const chainSlug of chains) {
    try {
      const r = await runOpenSeaStatsSync(chainSlug, batch);
      totals[chainSlug] += r.updated;
      if (r.updated > 0 || r.slugResolved > 0 || r.displayUpdated > 0) progressed = true;
      console.log(`round ${round} ${chainSlug}: ${JSON.stringify(r)} (cumulative updated: ${totals[chainSlug]})`);
    } catch (err) {
      console.log(`round ${round} ${chainSlug}: ERR ${err?.message ?? err}`);
    }
  }
  const budget = readSourceBudget("opensea-stats");
  if (budget.jailed) {
    const waitMs = Math.max(5_000, (budget.jailedUntil ?? Date.now()) - Date.now());
    console.log(`=== opensea-stats jailed, sleeping ${Math.ceil(waitMs / 1000)}s ===`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    continue;
  }
  if (!progressed) {
    console.log("=== no remaining candidates this round, stopping early ===");
    break;
  }
}
console.log(`=== pass complete: ${JSON.stringify(totals)} ===`);
