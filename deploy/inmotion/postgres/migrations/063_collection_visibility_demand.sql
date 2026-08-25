-- Viewport-aware continuous hydration -- docs/marketplank/GROK-FINDINGS-
-- viewport-predictive-hydration-2026-08-25.md. Tracks which tracked
-- collections are currently (or were recently) visible in an open browser
-- tab, so lib/market/multichain/collection-demand.ts's
-- prioritizeVisibleCollections() can give them a higher mesh-lane queue
-- priority than plain background cadence -- an OS-style priority-aging
-- queue (Workable job aging / classic OS scheduler aging), not a new data
-- source. This table ONLY influences plank_data_jobs.priority via
-- enqueueDataJob's existing GREATEST-on-conflict upsert; it never triggers a
-- direct third-party API call and never changes venue-level coverage
-- classifications (see that function's own module docstring).
--
-- Additive only; nothing before this migration ever queries this table.
CREATE TABLE IF NOT EXISTS collection_visibility_demand (
  chain_slug        text NOT NULL,
  collection_key    text NOT NULL,
  first_visible_at  timestamptz NOT NULL DEFAULT now(),
  last_visible_at   timestamptz NOT NULL DEFAULT now(),
  visible_hits      int NOT NULL DEFAULT 1,
  last_hydrated_at  timestamptz,
  current_priority  int NOT NULL DEFAULT 110,
  last_enqueued_at  timestamptz,
  PRIMARY KEY (chain_slug, collection_key)
);

-- Hot path for a future TTL sweep ("delete/ignore rows with last_visible_at
-- older than ~2h so the table stays small", per the design doc's section 4)
-- -- not yet wired to a scheduled job in this pass (see collection-
-- demand.ts's module docstring for that honestly-flagged follow-up), but the
-- index is cheap to add now so that sweep is a plain index scan later.
CREATE INDEX IF NOT EXISTS collection_visibility_demand_last_visible
  ON collection_visibility_demand (last_visible_at DESC);
