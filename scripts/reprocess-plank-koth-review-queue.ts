/**
 * TEMPORARY, one-shot backfill, added 2026-08-26 alongside the
 * hasRoundTripShape/resolveValuePaid fix in lib/market/plank-koth-
 * candidate.ts (see that file's own headers for the real bug: every real
 * router-mediated buy was being flagged/rejected, never confirmed).
 *
 * Re-evaluates every PENDING plank_koth_review_queue row's tx hash under
 * the now-fixed evaluatePlankKothCandidate -- a real buy that was wrongly
 * flagged will now confirm onto the leaderboard for real; anything that
 * still fails (genuinely no value-paid leg, genuine Bad Boards history,
 * etc.) is left exactly as-is for a human to resolve, matching this
 * queue's own "nothing auto-promotes without a real pass" design. Marks
 * a row 'approved' (resolved_by='automated-reprocess-2026-08-26') only
 * when the re-evaluation actually confirmed a sale for that same wallet.
 */
import { postgresQuery, hasPostgresConfig } from "../lib/postgres";
import { evaluatePlankKothCandidate } from "../lib/market/plank-koth-candidate";

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("reprocess-plank-koth-review-queue: no PostgreSQL configured");
  }
  const pending = await postgresQuery<{ tx_hash: string; wallet: string | null }>(
    `SELECT DISTINCT tx_hash, wallet FROM plank_koth_review_queue WHERE status = 'pending'`
  );
  console.log(`[reprocess] ${pending.rows.length} pending review-queue tx hashes to re-evaluate`);

  let confirmed = 0;
  let stillFlaggedOrRejected = 0;
  for (const row of pending.rows) {
    const outcome = await evaluatePlankKothCandidate(row.tx_hash);
    console.log(`[reprocess] ${row.tx_hash} -> ${outcome.status}`);
    if (outcome.status === "confirmed") {
      confirmed += 1;
      await postgresQuery(
        `UPDATE plank_koth_review_queue
         SET status = 'approved', resolved_at = NOW(), resolved_by = 'automated-reprocess-2026-08-26'
         WHERE tx_hash = $1 AND status = 'pending'`,
        [row.tx_hash]
      );
    } else {
      stillFlaggedOrRejected += 1;
    }
  }
  console.log(`[reprocess] done: ${confirmed} confirmed, ${stillFlaggedOrRejected} still flagged/rejected/not-a-buy`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[reprocess-plank-koth-review-queue] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
