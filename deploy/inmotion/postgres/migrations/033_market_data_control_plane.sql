-- Durable market-data admission, scheduling and coverage state.
-- Provider limits are shared by every Passenger worker, cron and mesh child;
-- process-local counters cannot enforce an account-wide allowance.

CREATE TABLE IF NOT EXISTS plank_provider_windows (
  provider_account TEXT NOT NULL,
  window_key TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  window_ends_at TIMESTAMPTZ NOT NULL,
  allowance BIGINT NOT NULL CHECK (allowance >= 0),
  reserved BIGINT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumed BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_account, window_key, window_started_at)
);

CREATE INDEX IF NOT EXISTS plank_provider_windows_active_idx
  ON plank_provider_windows (provider_account, window_key, window_ends_at DESC);

CREATE TABLE IF NOT EXISTS plank_data_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  chain_slug TEXT,
  subject TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS plank_data_jobs_claim_idx
  ON plank_data_jobs (priority DESC, not_before, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS plank_data_jobs_lease_idx
  ON plank_data_jobs (lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS plank_collection_cells (
  chain_slug TEXT NOT NULL,
  collection_key TEXT NOT NULL,
  cell TEXT NOT NULL,
  source TEXT,
  source_observed_at TIMESTAMPTZ,
  source_block BIGINT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  coverage DOUBLE PRECISION CHECK (coverage IS NULL OR (coverage >= 0 AND coverage <= 1)),
  state TEXT NOT NULL DEFAULT 'fresh'
    CHECK (state IN ('fresh', 'stale', 'partial', 'unavailable', 'unsupported', 'invalidated')),
  last_error TEXT,
  version BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (chain_slug, collection_key, cell)
);

CREATE INDEX IF NOT EXISTS plank_collection_cells_refresh_idx
  ON plank_collection_cells (cell, valid_until, refreshed_at);
