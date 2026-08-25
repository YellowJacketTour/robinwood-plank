import { scanChainForFillsGenesisBackfillViaHypersync } from "../lib/market/multichain/discovery/hypersync-seaport-scan.ts";
import { EVM_CHAIN_ID } from "../lib/market/multichain/discovery/evm-log-scan.ts";

// Real full-history Seaport fill backfill, live 2026-08-20 ("i want from
// all genesis blocks no exceptions") -- walks every EVM chain forward
// from block 0 in 50k-block windows until it reaches current head. Real
// work, not a demo: each call is a genuine HyperSync log query + write,
// same circuit breaker (source-budget.ts, SOURCE="hypersync-seaport")
// protecting the free-tier ceiling this session already established.
// Bounded pass + clean exit, same crash-resilient short-pass pattern as
// _backfill-loop-single-pass.mjs.
const chains = Object.keys(EVM_CHAIN_ID);
const started = Date.now();
let round = 0;
const totals = Object.fromEntries(chains.map((c) => [c, 0]));
while (Date.now() - started < 1000 * 60 * 4) {
  round += 1;
  for (const chainSlug of chains) {
    try {
      const r = await scanChainForFillsGenesisBackfillViaHypersync(chainSlug);
      totals[chainSlug] += r.fillsWritten;
      console.log(`round ${round} ${chainSlug}: block ${r.fromBlock}->${r.toBlock}, logs=${r.logsScanned}, written=${r.fillsWritten}${r.error ? ` ERR:${r.error}` : ""} (cumulative written: ${totals[chainSlug]})`);
    } catch (err) {
      console.log(`round ${round} ${chainSlug}: EXCEPTION ${err?.message ?? err}`);
    }
  }
}
console.log(`=== pass complete: ${JSON.stringify(totals)} ===`);
