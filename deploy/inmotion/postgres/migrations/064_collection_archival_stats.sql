-- Opportunistic Archival Ledger -- docs/marketplank/GROK-FINDINGS-
-- sustainable-archival-mining-2026-08-25.md, build order items 1 and 4.
--
-- Per-collection archival completeness: of the KNOWN token universe for a
-- collection, how much has ever been durably hydrated from a real source.
-- This is a durable, monotonically-increasing counter row, never a live
-- market signal -- it never gates trading/fulfillment and never flips a
-- venue's own `partial`/`unavailable` coverage classification.
--
-- Fail-closed scoring lives in application code (lib/market/multichain/
-- archival-ledger.ts computeArchivalScore): archival_score stays NULL
-- (score_method='unknown_supply') whenever known_supply is not a real
-- positive number -- this table only stores whatever that function last
-- computed, it never computes a fabricated percentage itself.
CREATE TABLE IF NOT EXISTS collection_archival_stats (
  chain_slug            text NOT NULL,
  collection_key        text NOT NULL,
  known_supply          bigint,
  tokens_ever_hydrated  bigint NOT NULL DEFAULT 0,
  fills_ever_stored     bigint NOT NULL DEFAULT 0,
  first_archived_at     timestamptz,
  last_archived_at      timestamptz,
  organic_hits          bigint NOT NULL DEFAULT 0,
  archival_score        real,
  score_method          text,
  sibling_expansions_hour_bucket timestamptz,
  sibling_expansions_in_bucket   int NOT NULL DEFAULT 0,
  PRIMARY KEY (chain_slug, collection_key)
);

-- Cold-frontier selection (build order item 4): "pick collections with
-- organic_hits = 0 OR archival_score IS NULL OR archival_score < threshold,
-- least-recently-archived first" -- this index makes that a plain scan, not
-- a sequential scan over every tracked collection.
CREATE INDEX IF NOT EXISTS collection_archival_stats_frontier
  ON collection_archival_stats (last_archived_at ASC NULLS FIRST, organic_hits ASC);

-- One durable row gating how often the archival_frontier mesh lane is
-- allowed to actually do work -- same "durable last-ran-at check" pattern
-- other supervisors in this app use, just a dedicated singleton table
-- instead of overloading an unrelated cursor row. Only ever has one row.
CREATE TABLE IF NOT EXISTS archival_frontier_runs (
  id           boolean PRIMARY KEY DEFAULT true,
  last_run_at  timestamptz,
  CONSTRAINT archival_frontier_runs_singleton CHECK (id)
);
