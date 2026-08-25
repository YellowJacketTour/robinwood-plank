-- Freshness Budget Controller (FBC) state -- docs/marketplank/GROK-FINDINGS-
-- biggest-issues-unified-vision-2026-08-25.md, "Issue 2 -- Graceful
-- degradation under hard free-tier QPS". Sits ABOVE lib/market/multichain/
-- singleflight-cache.ts: singleflight already coalesces concurrent callers
-- and does stale-while-revalidate between one soft/hard TTL pair. FBC adds a
-- second, independent axis on top -- how much of a given upstream provider's
-- free-tier quota has this whole app (not just this one cache key) spent
-- recently -- and widens TTL / refuses new upstream calls as that spend
-- approaches its ceiling, so one hot cache key going stale-past-hard-TTL
-- during a traffic spike doesn't turn into a 429 storm against the shared
-- provider quota that every OTHER cache key for that provider also depends
-- on.
--
-- NOT the same table as the existing per-key bulk-indexing budget/jail
-- systems in lib/market/multichain/discovery/{helius,alchemy,opensea}-key-
-- pool.ts and source-budget.ts (plank_provider_windows,
-- plank_source_budget, jail tables from earlier migrations) -- those solve
-- key rotation and circuit-breaking for BACKGROUND INDEXING jobs. This table
-- is a coarse, provider-wide (not per-key) counter consulted synchronously
-- on the LIVE, user-facing getOrRefresh() hot path, and is deliberately
-- simpler: one row per provider per fixed time window, incremented with a
-- single fast UPDATE (never a held transaction spanning a network fetch --
-- see singleflight-cache.ts's header on why PGPOOL_MAX=4 rules that out).
--
-- WINDOW SHAPE: a fixed-size rolling window keyed by provider + window
-- start (window_start truncated to a whole window boundary, e.g. to the
-- minute -- see lib/market/multichain/freshness-budget.ts for the exact
-- window length and truncation used). A new window is a fresh row (upsert),
-- not a decay/leak function -- simplest correct thing for a single-writer-
-- pattern counter with no long-held locks.
--
-- Additive only; nothing before this migration ever queries this table.
CREATE TABLE IF NOT EXISTS plank_provider_budget (
  provider TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  calls_used INTEGER NOT NULL DEFAULT 0,
  soft_ceiling INTEGER NOT NULL,
  hard_ceiling INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, window_start)
);

-- Hot-path read is always "give me the current window's row for this
-- provider" -- the primary key already serves that as a point lookup, but a
-- secondary index on provider alone makes "most recent window for this
-- provider" (used to seed a brand-new window with the last known
-- ceilings if the caller doesn't pass explicit ones) cheap without a table
-- scan.
CREATE INDEX IF NOT EXISTS plank_provider_budget_provider_idx
  ON plank_provider_budget (provider, window_start DESC);
