/**
 * TEMPORARY diagnostic, added 2026-08-26 to answer a live production
 * question ("real buys are happening on-chain but the KOTH board shows
 * none") without ever moving production DB credentials outside GitHub
 * Actions' own SSH session -- reuses the exact SSH secrets/connection
 * provision-plank-koth-watch already uses, just runs a read-only query
 * instead of the watcher. Meant to be removed (along with its
 * build:koth-diag script and the diagnose-plank-koth-review-queue
 * workflow job) once this is answered -- see the commit that adds this
 * file for the removal follow-up.
 */
import { postgresQuery, hasPostgresConfig } from "../lib/postgres";

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("plank-koth-review-queue-dump: no PostgreSQL configured");
  }
  const review = await postgresQuery(
    `SELECT tx_hash, wallet, eth_paid_wei::text, plank_amount::text, block_number, reason, status, created_at
     FROM plank_koth_review_queue ORDER BY created_at DESC LIMIT 20`
  );
  const leaderboard = await postgresQuery(
    `SELECT tx_hash, wallet, eth_paid_wei::text, plank_amount::text, usd_value_at_buy, block_number, confirmed_at
     FROM plank_koth_leaderboard ORDER BY confirmed_at DESC LIMIT 20`
  );
  const koth = await postgresQuery(`SELECT * FROM plank_koth WHERE id = 1`);
  console.log("=== plank_koth_review_queue (newest 20) ===");
  console.log(JSON.stringify(review.rows, null, 2));
  console.log("=== plank_koth_leaderboard (newest 20) ===");
  console.log(JSON.stringify(leaderboard.rows, null, 2));
  console.log("=== plank_koth singleton row ===");
  console.log(JSON.stringify(koth.rows, null, 2));
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[plank-koth-review-queue-dump] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
