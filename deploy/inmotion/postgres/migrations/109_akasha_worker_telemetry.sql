-- Worker telemetry: make "the lane never ran" distinguishable from
-- "the lane ran and made no progress".
--
-- WHY THIS EXISTS
-- ---------------
-- Bitcoin's backfill has been frozen at blocksToProtocolT0 = 198,651 across
-- three separate investigations. Each one produced a plausible root cause that
-- turned out to be wrong, because from OUTSIDE the worker these three states
-- are IDENTICAL:
--
--   1. the akasha-hose process is not running at all
--   2. it is running, but something before the backfill throws every tick
--   3. it is running, the backfill executes, and it genuinely cannot advance
--
-- All three produce: a frozen number, a healthy-looking site, and no error on
-- any HTTP surface. The worker logs to stdout, which no route can read.
--
-- A COUNTER IS NOT ENOUGH. "backfill ran 400 times" still cannot separate case
-- 2 from case 3 if the run did nothing. So each phase records: that it STARTED
-- (attempts), that it FINISHED (completions), what it RETURNED (the reason
-- string the backfill already produces), and what it THREW. A phase whose
-- attempts climb while completions do not is throwing; a phase whose
-- completions climb while the tail does not move is the third case, and its
-- own reason string then says why.
--
-- One row per (chain, phase). Counters are cumulative; last_* fields hold the
-- most recent observation. This is deliberately tiny -- it is an instrument,
-- not a log store, so it cannot itself become the unbounded table that
-- migration 108 had to clean up after.

CREATE TABLE IF NOT EXISTS akasha_worker_phase (
  chain            TEXT NOT NULL,
  phase            TEXT NOT NULL,
  attempts         BIGINT NOT NULL DEFAULT 0,
  completions      BIGINT NOT NULL DEFAULT 0,
  failures         BIGINT NOT NULL DEFAULT 0,
  -- The single most useful field: the backfill ALREADY returns a reason
  -- ("epoch produced no header", "tail is at protocol_t0", "epoch did not
  -- hash-link...") and it was being discarded. Persisting it turns a silent
  -- stall into a sentence.
  last_reason      TEXT,
  last_error       TEXT,
  last_detail      JSONB,
  last_attempt_at  TIMESTAMPTZ,
  last_success_at  TIMESTAMPTZ,
  last_failure_at  TIMESTAMPTZ,
  PRIMARY KEY (chain, phase)
);

-- "Is the worker alive at all?" answered without reading any log. A boot row
-- is written once per process start, so a stale boot_at with a live site means
-- the worker died and nothing restarted it -- case 1, provable in one query.
CREATE TABLE IF NOT EXISTS akasha_worker_heartbeat (
  worker      TEXT PRIMARY KEY,
  pid         INTEGER,
  boot_at     TIMESTAMPTZ NOT NULL,
  last_tick_at TIMESTAMPTZ,
  tick_count  BIGINT NOT NULL DEFAULT 0,
  chains      TEXT,
  version     TEXT
);
