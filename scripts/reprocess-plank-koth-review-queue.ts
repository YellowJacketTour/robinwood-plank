/**
 * One-shot backfill: re-evaluates every PENDING plank_koth_review_queue
 * row's tx hash under the current evaluatePlankKothCandidate -- a real buy
 * that was wrongly flagged under an older version of the fraud-gate logic
 * will now confirm onto the leaderboard for real; anything that still
 * fails (genuinely no value-paid leg, genuine Bad Boards history, etc.) is
 * left exactly as-is for a human to resolve, matching this queue's own
 * "nothing auto-promotes without a real pass" design. Marks a row
 * 'approved' only when the re-evaluation actually confirms a sale.
 *
 * Real design change, 2026-08-26 (external Grok research review):
 * evaluatePlankKothCandidate now reads the transaction's real RPC receipt
 * directly (rpc-provider-pool.ts's throw-on-failure contract), not
 * Blockscout REST -- a real fetch failure now THROWS out of this script's
 * own per-tx call instead of silently misclassifying as not_a_buy, so the
 * ERROR log line below is a real, actionable signal now, not noise.
 */
import { postgresQuery, hasPostgresConfig } from "../lib/postgres";
import { evaluatePlankKothCandidate } from "../lib/market/plank-koth-candidate";

/** Real regression found live 2026-08-26 (Blockscout-REST era of this
 * script): unbounded concurrency drowned the one upstream REST dependency
 * everything read from. The RPC-based rewrite above reads from a real
 * multi-provider pool (rpc-provider-pool.ts) with its own per-provider
 * jail/failover, which tolerates far more real concurrent load -- kept
 * modest here anyway since this is a one-shot maintenance script, not a
 * throughput-critical path. */
const CONCURRENCY = 5;

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("reprocess-plank-koth-review-queue: no PostgreSQL configured");
  }
  const limit = Number(process.env.KOTH_REPROCESS_LIMIT ?? "500");
  const pending = await postgresQuery<{ tx_hash: string; wallet: string | null }>(
    `SELECT DISTINCT tx_hash, wallet FROM plank_koth_review_queue WHERE status = 'pending' LIMIT $1`,
    [limit]
  );
  console.log(`[reprocess] ${pending.rows.length} pending review-queue tx hashes to re-evaluate (concurrency=${CONCURRENCY})`);

  const results: Array<"confirmed" | "still-flagged-or-rejected"> = [];
  for (let i = 0; i < pending.rows.length; i += CONCURRENCY) {
    const batch = pending.rows.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (row) => {
        const outcome = await evaluatePlankKothCandidate(row.tx_hash).catch((error) => {
          console.error(`[reprocess] ${row.tx_hash} -> ERROR`, error instanceof Error ? error.message : error);
          return null;
        });
        if (outcome) console.log(`[reprocess] ${row.tx_hash} -> ${outcome.status}`);
        if (outcome?.status === "confirmed") {
          await postgresQuery(
            `UPDATE plank_koth_review_queue
             SET status = 'approved', resolved_at = NOW(), resolved_by = 'automated-reprocess-2026-08-26'
             WHERE tx_hash = $1 AND status = 'pending'`,
            [row.tx_hash]
          );
          return "confirmed" as const;
        }
        return "still-flagged-or-rejected" as const;
      })
    );
    results.push(...batchResults);
  }
  const confirmed = results.filter((r) => r === "confirmed").length;
  console.log(`[reprocess] done: ${confirmed} confirmed, ${results.length - confirmed} still flagged/rejected/not-a-buy/errored`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("[reprocess-plank-koth-review-queue] fatal", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
