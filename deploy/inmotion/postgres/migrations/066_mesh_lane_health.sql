-- Real, no-log-watching-required health/heartbeat for every mesh lane --
-- Unified Mesh Continuum build item #2, docs/marketplank/
-- GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md. Real incident this
-- exists to catch sooner: the 2026-08-25 genesis-seaport-backfill disk-fill
-- (a lane spinning at zero real progress for hours before anyone noticed)
-- and the 2026-08-26 OpenSea jail cycle (every job for a source silently
-- skipped for many rounds) -- both were only found by manually tailing a
-- log file. This table lets a lane's real state (last claim, last real
-- success, last real progress, consecutive empty rounds) be queried
-- directly instead.
CREATE TABLE IF NOT EXISTS mesh_lane_health (
  lane_key text PRIMARY KEY,
  last_claim_at timestamptz,
  last_success_at timestamptz,
  -- Distinct from last_success_at: a lane can "succeed" (exit 0) while
  -- doing zero real work (e.g. evm-metadata's own {"attempted":0} rounds,
  -- observed live 2026-08-26) -- last_progress_at only advances when the
  -- lane itself reports real forward movement (a row written, a cursor
  -- advanced), never merely "the process exited cleanly".
  last_progress_at timestamptz,
  consecutive_empty integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'backoff', 'jailed', 'stalled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
