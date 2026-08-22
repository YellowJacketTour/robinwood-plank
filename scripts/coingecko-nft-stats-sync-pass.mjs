import { runCoinGeckoNftStats } from "../lib/market/multichain/discovery/coingecko-nft-stats.ts";

// Real convergence driver for the CoinGecko 24h volume/sales/floor-change
// gap on Solana + Bitcoin. A real COINGECKO_API_KEY (Demo tier, free)
// raises CoinGecko's rate limit from ~5-15 calls/min unauthenticated to
// 100/min -- confirmed live 2026-08-20 (30 real updates in 1.5s once the
// key was wired in). MAX_UPDATES_PER_CALL scales with that: still small
// batches so this loop stays interruptible/resumable, but far larger
// than the unauthenticated-pace default. Logs every round immediately
// (no buffering) so progress is visible while it runs, not just at the
// end.
const MAX_UPDATES_PER_CALL = process.env.COINGECKO_API_KEY ? 150 : 25;
const started = Date.now();
let round = 0;
let totalUpdated = { "solana-mainnet": 0, "bitcoin-mainnet": 0 };
while (Date.now() - started < 1000 * 60 * 8) {
  round += 1;
  for (const chainSlug of ["solana-mainnet", "bitcoin-mainnet"]) {
    try {
      const r = await runCoinGeckoNftStats(chainSlug, MAX_UPDATES_PER_CALL);
      totalUpdated[chainSlug] += r.updated;
      console.log(`round ${round} ${chainSlug}: ${JSON.stringify(r)} (cumulative updated: ${totalUpdated[chainSlug]})`);
    } catch (err) {
      console.log(`round ${round} ${chainSlug}: ERR ${err?.message ?? err}`);
    }
  }
}
console.log(`=== pass complete: ${JSON.stringify(totalUpdated)} ===`);
