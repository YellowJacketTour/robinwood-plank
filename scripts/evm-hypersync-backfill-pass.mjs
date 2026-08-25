import { runHypersyncDiscoveryScan, runHypersyncBackfillScan } from "../lib/market/multichain/discovery/hypersync-evm-scan.ts";
import { EVM_CHAIN_ID } from "../lib/market/multichain/discovery/evm-log-scan.ts";

// Bounded to ~3 minutes per process, then exits cleanly -- the
// crash-resilient supervisor (_backfill-supervisor.sh) relaunches a fresh
// process immediately. Short passes mean a crash loses at most a few
// rounds of in-flight work (cursors persist in Postgres regardless), and
// starting fresh each pass avoids whatever memory growth might have
// contributed to the earlier segfault under a long-lived single process.
const chains = Object.keys(EVM_CHAIN_ID);
const started = Date.now();
let round = 0;
while (Date.now() - started < 1000 * 60 * 3) {
  round += 1;
  const line = [];
  for (const chainSlug of chains) {
    try {
      const fwd = await runHypersyncDiscoveryScan({ chainSlug });
      if (fwd.registered > 0) line.push(`${chainSlug}:+${fwd.registered}`);
    } catch (e) {
      console.log(`[fwd-err] ${chainSlug}: ${e instanceof Error ? e.message : e}`);
    }
    try {
      const bak = await runHypersyncBackfillScan({ chainSlug });
      if (bak.registered > 0) line.push(`${chainSlug}:backfill+${bak.registered}@${bak.fromBlock}`);
    } catch (e) {
      console.log(`[bak-err] ${chainSlug}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`round ${round}: ${line.join(" ") || "(no new candidates)"}`);
}
process.exit(0);
