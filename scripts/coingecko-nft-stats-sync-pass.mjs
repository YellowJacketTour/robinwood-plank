import { runCoinGeckoNftStats } from "../lib/market/multichain/discovery/coingecko-nft-stats.ts";

// Real convergence driver for the CoinGecko 24h volume/sales/floor-change
// gap on Solana + Bitcoin -- unauthenticated CoinGecko rate limit is real
// and low (5-15 calls/min), so this keeps calling in small maxUpdates
// batches for a bounded window rather than one giant blocking call, same
// resumable-progress reasoning as the other supervisor loops this session
// already uses. Logs every round immediately (no buffering) so progress
// is visible while it runs, not just at the end.
const started = Date.now();
let round = 0;
let totalUpdated = { "solana-mainnet": 0, "bitcoin-mainnet": 0 };
while (Date.now() - started < 1000 * 60 * 8) {
  round += 1;
  for (const chainSlug of ["solana-mainnet", "bitcoin-mainnet"]) {
    try {
      const r = await runCoinGeckoNftStats(chainSlug, 25);
      totalUpdated[chainSlug] += r.updated;
      console.log(`round ${round} ${chainSlug}: ${JSON.stringify(r)} (cumulative updated: ${totalUpdated[chainSlug]})`);
    } catch (err) {
      console.log(`round ${round} ${chainSlug}: ERR ${err?.message ?? err}`);
    }
  }
}
console.log(`=== pass complete: ${JSON.stringify(totalUpdated)} ===`);
