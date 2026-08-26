-- Track B of the 2026-08-26 KOTH data-plane rework (external Grok research
-- review, docs/marketplank/GROK-ONESHOT-plank-koth-total-coverage-2026-08-26.md).
-- Real gap found live the same night: the only way to see a long-running
-- backfill job's progress was tailing a CI log after the fact -- no durable,
-- externally-queryable record existed, so a slow job and a genuinely stuck
-- one were indistinguishable without guessing from elapsed wall-clock time.
-- A row here is heartbeated at least every ~15s by any real batch/scan job;
-- a stalled job is detected by heartbeat_at going quiet, not by watching a log.
CREATE TABLE IF NOT EXISTS contest_job_runs (
  id            BIGSERIAL PRIMARY KEY,
  job_kind      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'ok', 'failed', 'stalled')),
  cursor_block  BIGINT,
  head_block    BIGINT,
  total_items   INTEGER,
  done_items    INTEGER NOT NULL DEFAULT 0,
  current_item  TEXT,
  tally_ok      INTEGER NOT NULL DEFAULT 0,
  tally_hold    INTEGER NOT NULL DEFAULT 0,
  tally_reject  INTEGER NOT NULL DEFAULT 0,
  -- Source/fetch failures -- deliberately its own column, never folded into
  -- tally_reject: "our data source failed" and "we positively classified
  -- this as not a real buy" must never collapse into the same number again
  -- (see plank-koth-rpc-scan.ts's own header for the bug this closes).
  tally_error   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS contest_job_runs_kind_started_idx
  ON contest_job_runs (job_kind, started_at DESC);
CREATE INDEX IF NOT EXISTS contest_job_runs_running_idx
  ON contest_job_runs (status, heartbeat_at) WHERE status = 'running';

-- Per-tx classification outcome, durable and queryable independent of
-- plank_koth_review_queue/plank_koth_leaderboard (those only ever get a row
-- for a tx that made it PAST source-fetch, real proof this ledger exists
-- for the source_error case those two tables never see).
CREATE TABLE IF NOT EXISTS contest_eval_results (
  tx_hash       TEXT PRIMARY KEY,
  status        TEXT NOT NULL
    CHECK (status IN ('pending_source', 'candidate', 'confirmed', 'hold', 'reject', 'source_error')),
  source        TEXT,
  reason        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
