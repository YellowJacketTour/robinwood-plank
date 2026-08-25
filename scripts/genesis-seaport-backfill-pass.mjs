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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chains = Object.keys(EVM_CHAIN_ID);
const started = Date.now();
let round = 0;
const totals = Object.fromEntries(chains.map((c) => [c, 0]));
while (Date.now() - started < 1000 * 60 * 4) {
  round += 1;
  let allJailed = true;
  for (const chainSlug of chains) {
    try {
      const r = await scanChainForFillsGenesisBackfillViaHypersync(chainSlug);
      totals[chainSlug] += r.fillsWritten;
      const isJailed = Boolean(r.error?.includes("jailed/exhausted"));
      allJailed = allJailed && isJailed;
      // Real jailed/exhausted calls return instantly (no network I/O) and
      // repeat identically every round -- log only the first occurrence per
      // chain per pass so a multi-day jail can't spin the disk full again
      // (real incident: this loop had no per-round delay at all, so once
      // jailed it spun thousands of rounds in 4 minutes, filling 61GB of
      // logs over 5 days before anything noticed -- see git history).
      if (!isJailed || totals[`${chainSlug}:loggedJail`] !== true) {
        console.log(`round ${round} ${chainSlug}: block ${r.fromBlock}->${r.toBlock}, logs=${r.logsScanned}, written=${r.fillsWritten}${r.error ? ` ERR:${r.error}` : ""} (cumulative written: ${totals[chainSlug]})`);
        if (isJailed) totals[`${chainSlug}:loggedJail`] = true;
      }
    } catch (err) {
      allJailed = false;
      console.log(`round ${round} ${chainSlug}: EXCEPTION ${err?.message ?? err}`);
    }
  }
  // If every chain is jailed, there is no real work to do until the jail
  // clears -- sleep out the rest of this pass instead of spinning.
  if (allJailed) {
    console.log(`round ${round}: all sources jailed/exhausted, sleeping rest of pass`);
    await sleep(Math.max(0, 1000 * 60 * 4 - (Date.now() - started)));
    break;
  }
  await sleep(500);
}
console.log(`=== pass complete: ${JSON.stringify(totals)} ===`);
