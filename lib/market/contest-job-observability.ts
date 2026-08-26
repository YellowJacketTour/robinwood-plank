/**
 * Track B of the 2026-08-26 KOTH data-plane rework (external Grok research
 * review) -- see migration 083's own header for the real gap this closes:
 * a long-running batch/scan job's only signal used to be a CI log tailed
 * after the fact, so "slow" and "stuck" were indistinguishable without
 * guessing from elapsed wall-clock time. Any job worth watching now writes
 * a heartbeated row here that an admin route (or a human) can poll live.
 */
import { postgresQuery } from "@/lib/postgres";

export type JobTally = { ok?: number; hold?: number; reject?: number; error?: number };

export async function startJobRun(jobKind: string, totalItems?: number): Promise<number> {
  const result = await postgresQuery<{ id: string }>(
    `INSERT INTO contest_job_runs (job_kind, status, total_items) VALUES ($1, 'running', $2) RETURNING id`,
    [jobKind, totalItems ?? null]
  );
  return Number(result.rows[0].id);
}

/**
 * Call this at least every ~15s from inside any real work loop -- a job
 * that goes quiet longer than STALL_THRESHOLD_MS (see isJobStalled) reads
 * as genuinely stuck to anything polling this table, not just "still
 * running." Every field is optional so a caller can report only what it
 * knows at that point without clobbering the rest.
 */
export async function heartbeatJobRun(
  runId: number,
  update: {
    currentItem?: string;
    cursorBlock?: number;
    headBlock?: number;
    doneItemsDelta?: number;
    tally?: JobTally;
    lastError?: string;
  }
): Promise<void> {
  await postgresQuery(
    `UPDATE contest_job_runs SET
       heartbeat_at = NOW(),
       current_item = COALESCE($2, current_item),
       cursor_block = COALESCE($3, cursor_block),
       head_block = COALESCE($4, head_block),
       done_items = done_items + COALESCE($5, 0),
       tally_ok = tally_ok + COALESCE($6, 0),
       tally_hold = tally_hold + COALESCE($7, 0),
       tally_reject = tally_reject + COALESCE($8, 0),
       tally_error = tally_error + COALESCE($9, 0),
       last_error = COALESCE($10, last_error)
     WHERE id = $1`,
    [
      runId,
      update.currentItem ?? null,
      update.cursorBlock ?? null,
      update.headBlock ?? null,
      update.doneItemsDelta ?? null,
      update.tally?.ok ?? null,
      update.tally?.hold ?? null,
      update.tally?.reject ?? null,
      update.tally?.error ?? null,
      update.lastError ?? null,
    ]
  );
}

export async function finishJobRun(runId: number, status: "ok" | "failed", lastError?: string): Promise<void> {
  await postgresQuery(
    `UPDATE contest_job_runs SET status = $2, finished_at = NOW(), last_error = COALESCE($3, last_error) WHERE id = $1`,
    [runId, status, lastError ?? null]
  );
}

/** A `running` row whose heartbeat has gone quiet this long reads as
 * genuinely stalled -- generous enough that a real single-item worst case
 * (a slow RPC retry) never false-positives, tight enough that a truly hung
 * job is visible within well under a minute of polling this table. */
const STALL_THRESHOLD_MS = 45_000;

export async function markStalledJobRuns(): Promise<number> {
  const result = await postgresQuery(
    `UPDATE contest_job_runs SET status = 'stalled'
     WHERE status = 'running' AND heartbeat_at < NOW() - ($1 || ' milliseconds')::interval`,
    [STALL_THRESHOLD_MS]
  );
  return result.rowCount ?? 0;
}

export type ContestJobRunRow = {
  id: number;
  job_kind: string;
  status: string;
  cursor_block: number | null;
  head_block: number | null;
  total_items: number | null;
  done_items: number;
  current_item: string | null;
  tally_ok: number;
  tally_hold: number;
  tally_reject: number;
  tally_error: number;
  last_error: string | null;
  heartbeat_at: string;
  started_at: string;
  finished_at: string | null;
};

export async function listRecentJobRuns(limit = 20): Promise<ContestJobRunRow[]> {
  await markStalledJobRuns().catch(() => {});
  const result = await postgresQuery<ContestJobRunRow>(
    `SELECT id, job_kind, status, cursor_block, head_block, total_items, done_items, current_item,
            tally_ok, tally_hold, tally_reject, tally_error, last_error,
            heartbeat_at, started_at, finished_at
     FROM contest_job_runs ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function upsertEvalResult(input: {
  txHash: string;
  status: "pending_source" | "candidate" | "confirmed" | "hold" | "reject" | "source_error";
  source: string;
  reason?: string;
}): Promise<void> {
  await postgresQuery(
    `INSERT INTO contest_eval_results (tx_hash, status, source, reason, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (tx_hash) DO UPDATE SET
       status = EXCLUDED.status, source = EXCLUDED.source, reason = EXCLUDED.reason, updated_at = NOW()`,
    [input.txHash, input.status, input.source, input.reason ?? null]
  );
}
