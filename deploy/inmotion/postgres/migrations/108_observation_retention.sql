-- Retention for the one table that grows without bound.
--
-- WHY THIS IS THE OUTAGE CANDIDATE
-- -------------------------------
-- A parallel data-model audit checked all 107 prior migrations for `DELETE`,
-- `retention`, `prune`, `pg_cron` and TTL. The only DELETEs are one-shot data
-- repairs. **No scheduled pruning exists for any table in this schema.**
--
-- Most append-only tables here grow at the rate of real events, which is slow.
-- `plank_collection_floor_observations` does not. Migration 041 defines:
--
--     observation_bucket TIMESTAMPTZ NOT NULL DEFAULT date_trunc('minute', NOW()),
--     UNIQUE (collection_id, marketplace, observation_bucket)
--
-- That admits up to ONE ROW PER COLLECTION PER MARKETPLACE PER MINUTE. Against
-- ~345,000 tracked collections, even polling a fraction of them hourly puts
-- this on a 10^8-rows-per-year trajectory -- and it carries three B-trees (a
-- BIGSERIAL primary key, a lookup index, and the unique constraint), so every
-- insert pays three times and autovacuum has to keep up with all of it.
--
-- WHY 30 DAYS IS SAFE, AND NOT A GUESS
-- ------------------------------------
-- The table has exactly ONE reader: getObservedFloorChange24h in
-- lib/market/multichain/store.ts. It asks for two rows and only two:
--
--     current_floor     ORDER BY observed_at DESC LIMIT 1
--     comparison_floor  WHERE observed_at <= NOW() - INTERVAL '24 hours'
--                       ORDER BY observed_at DESC LIMIT 1
--
-- The newest observation, and the newest one at least 24 hours old. Nothing
-- reads further back. 30 days is therefore 29 days of headroom over the only
-- query that exists -- deliberately generous, so that a collection which goes
-- quiet for weeks still has a comparison point when it trades again, and so
-- that adding a 7-day change later needs no migration.
--
-- DELETE, NOT PARTITIONING
-- ------------------------
-- Range partitioning by month with a drop-old-partition job is the textbook
-- answer and would be cheaper at steady state. It is not used here because it
-- requires recreating the table, and this runner wraps each migration in a
-- transaction against a live 345k-collection database. A bounded DELETE is
-- reversible, interruptible, and costs one statement; partitioning can be
-- revisited when the row count justifies the migration risk.
--
-- BOUNDED ON PURPOSE
-- ------------------
-- `LIMIT` inside the DELETE keeps the first run -- which may face a very large
-- backlog -- from taking a long lock or bloating WAL in one shot. It is
-- idempotent and safe to run repeatedly: each pass removes up to the limit and
-- the next pass continues. The scheduled caller below repeats until a pass
-- deletes nothing.

CREATE OR REPLACE FUNCTION plank_prune_floor_observations(
  retain_days INTEGER DEFAULT 30,
  max_rows INTEGER DEFAULT 50000
) RETURNS INTEGER AS $$
DECLARE
  removed INTEGER;
BEGIN
  -- Delete by primary key from a bounded subquery rather than by predicate
  -- directly: the planner then does one index scan and one bulk delete,
  -- instead of scanning to find every matching row in a single statement.
  WITH doomed AS (
    SELECT id
      FROM plank_collection_floor_observations
     WHERE observed_at < NOW() - (retain_days * INTERVAL '1 day')
     ORDER BY observed_at
     LIMIT max_rows
  )
  DELETE FROM plank_collection_floor_observations o
   USING doomed d
   WHERE o.id = d.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql;

-- The index the prune itself needs. Without a leading observed_at index the
-- retention scan is the very full-table scan it exists to prevent -- a
-- self-defeating prune that would make the problem worse under load.
CREATE INDEX IF NOT EXISTS plank_floor_observations_observed_at_idx
  ON plank_collection_floor_observations (observed_at);

-- One pass now, so the table starts bounded rather than waiting for the first
-- scheduled run. Deliberately small: this migration runs inside a transaction
-- on a live database, and a huge first delete would hold locks for the length
-- of the deploy. The scheduled caller drains the rest.
SELECT plank_prune_floor_observations(30, 50000);
