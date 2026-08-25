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
// Real bug fixed 2026-08-23: this loop was retrying a hit "durable daily
// ceiling" error every iteration with zero delay -- confirmed live, one
// local pass logged 209,000+ identical rounds in under 8 minutes, 100%
// wasted (the ceiling resets on a UTC day boundary, not on the next tick).
// Once BOTH chains report the ceiling error in the same round, there is
// nothing this pass can do until the day rolls over, so it sleeps until
// then instead of hot-looping. Any other error (a real transient failure)
// still retries immediately next round, unchanged.
function msUntilNextUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}
while (Date.now() - started < 1000 * 60 * 8) {
  round += 1;
  let ceilingHits = 0;
  for (const chainSlug of ["solana-mainnet", "bitcoin-mainnet"]) {
    try {
      const r = await runCoinGeckoNftStats(chainSlug, MAX_UPDATES_PER_CALL);
      totalUpdated[chainSlug] += r.updated;
      console.log(`round ${round} ${chainSlug}: ${JSON.stringify(r)} (cumulative updated: ${totalUpdated[chainSlug]})`);
    } catch (err) {
      const message = err?.message ?? String(err);
      if (message.includes("durable daily ceiling")) ceilingHits += 1;
      console.log(`round ${round} ${chainSlug}: ERR ${message}`);
    }
  }
  if (ceilingHits === 2) {
    const wait = msUntilNextUtcDay();
    console.log(`round ${round}: both chains hit the real daily ceiling -- sleeping ${Math.round(wait / 60000)}m until UTC day rollover instead of hot-looping`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1000 * 60 * 8)));
    break;
  }
}
console.log(`=== pass complete: ${JSON.stringify(totalUpdated)} ===`);
