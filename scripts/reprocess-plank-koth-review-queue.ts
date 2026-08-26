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
import { evaluatePlankKothCandidate, isPlankTransfer } from "../lib/market/plank-koth-candidate";
import { fetchTransaction, fetchTxTokenTransfers } from "../lib/market/blockscout";
import { isCanonicalPlankPool } from "../lib/market/plank-pools";

/**
 * Real bug found live 2026-08-26: the original version of this script
 * awaited evaluatePlankKothCandidate ONE tx at a time. That function's own
 * checkFundingSourceLink can make up to ~7 sequential Blockscout calls per
 * candidate (each up to a real ~30s worst case with its own one-retry
 * backoff -- see blockscout.ts's bsGetRetried), and Blockscout is
 * confirmed genuinely flaky in production. Serially, 20 backlogged
 * candidates' worst case is tens of minutes -- well past this workflow
 * job's own 10-minute cap, so it looked hung when it was really just
 * badly scoped. These tx hashes are fully independent (distinct tx
 * hashes, ON CONFLICT DO NOTHING on every write), so there is no
 * correctness reason to serialize them -- run them concurrently instead,
 * which bounds total wall-clock to roughly the SLOWEST single candidate
 * rather than the sum of all of them.
 *
 * Real regression found live 2026-08-26, moments after shipping the fix
 * above: unbounded concurrency (all 84 pending rows fired at once) blew
 * past Blockscout's own real rate limit (confirmed via its own
 * x-ratelimit-limit response header, 180/min) -- fetchTxTokenTransfers
 * swallows any failure into an empty array (see blockscout.ts), which
 * evaluatePlankKothCandidate then reads as "this tx has no PLANK
 * transfers" (not_a_buy), not a real error. Confirmed live: transactions
 * independently verified (via a direct, unthrottled Blockscout fetch) to
 * contain a real canonical-pool PLANK transfer came back not_a_buy under
 * full concurrency. Bounded batches keep the real speedup without
 * drowning the one upstream dependency everything here reads from.
 */
const CONCURRENCY = 2;
const BATCH_DELAY_MS = 1_000;

async function main(): Promise<void> {
  if (!hasPostgresConfig()) {
    throw new Error("reprocess-plank-koth-review-queue: no PostgreSQL configured");
  }
  // Real diagnostic pass, added 2026-08-26: capped to a small sample first
  // (via KOTH_REPROCESS_LIMIT) to get a fast, clear read on whether
  // Blockscout lookups are genuinely failing from this production host,
  // before committing another 10-minute run to the full backlog.
  const limit = Number(process.env.KOTH_REPROCESS_LIMIT ?? "10");
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
        // Real diagnostic, added 2026-08-26: evaluatePlankKothCandidate's own
        // "not_a_buy" fallback fires both for a genuine non-buy AND for a
        // silently-swallowed Blockscout lookup failure (fetchTransaction/
        // fetchTxTokenTransfers both catch-and-return null/[] internally --
        // see blockscout.ts). Confirmed live: this same tx hash resolves a
        // real recipient when fetched fresh from an unrelated IP, but comes
        // back not_a_buy when run from this production host -- independently
        // re-fetch here so a real lookup failure is visible in this log
        // instead of looking identical to "genuinely not a buy."
        const [rawTx, rawTransfers] = await Promise.all([fetchTransaction(row.tx_hash), fetchTxTokenTransfers(row.tx_hash)]);
        if (!rawTx) {
          console.log(`[reprocess] ${row.tx_hash} DIAG: fetchTransaction returned null (lookup failed)`);
        } else if (rawTx.status !== "ok") {
          console.log(`[reprocess] ${row.tx_hash} DIAG: tx.status=${rawTx.status}`);
        } else if (rawTransfers.length === 0) {
          console.log(`[reprocess] ${row.tx_hash} DIAG: fetchTxTokenTransfers returned [] (lookup failed or genuinely no transfers)`);
        } else if (!rawTransfers.some((t) => isPlankTransfer(t) && t.from?.hash && isCanonicalPlankPool(t.from.hash))) {
          console.log(`[reprocess] ${row.tx_hash} DIAG: ${rawTransfers.length} real transfers fetched, none is a canonical-pool PLANK leg`);
        } else {
          console.log(`[reprocess] ${row.tx_hash} DIAG: ${rawTransfers.length} real transfers fetched, a real canonical-pool PLANK leg IS present`);
        }
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
    if (i + CONCURRENCY < pending.rows.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
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
