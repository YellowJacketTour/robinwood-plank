import { runOpenSeaStatsSync } from "../lib/market/multichain/discovery/opensea-stats.ts";
import { FOREIGN_CHAINS } from "../lib/market/multichain/trading/foreign-chain-registry.ts";

// Bounded pass driving the real OpenSea-stats floor/24h-volume fallback
// (opensea-stats.ts) across every EVM chain with an OpenSea orderbook --
// the fix for the Floor/24h Volume cells left empty by Alchemy's own
// still-unrecovered NFT-API 429, confirmed live 2026-08-20. Chains with
// no OpenSea orderbook (zkSync, openSeaChain: null) are skipped, same as
// every other OpenSea-backed scan in this app.
const chains = FOREIGN_CHAINS.filter((c) => c.openSeaChain).map((c) => c.chainSlug);
const started = Date.now();
let round = 0;
const totals = Object.fromEntries(chains.map((c) => [c, 0]));
while (Date.now() - started < 1000 * 60 * 4) {
  round += 1;
  for (const chainSlug of chains) {
    try {
      const r = await runOpenSeaStatsSync(chainSlug, 20);
      totals[chainSlug] += r.updated;
      console.log(`round ${round} ${chainSlug}: ${JSON.stringify(r)} (cumulative updated: ${totals[chainSlug]})`);
    } catch (err) {
      console.log(`round ${round} ${chainSlug}: ERR ${err?.message ?? err}`);
    }
  }
}
console.log(`=== pass complete: ${JSON.stringify(totals)} ===`);
