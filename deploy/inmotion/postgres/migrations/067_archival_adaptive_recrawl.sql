-- Adaptive recrawl -- Unified Mesh Continuum build item #4, docs/marketplank/
-- GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md. Honest binary
-- change-detection (search-engine-style "did this actually change since
-- last time" recrawl scheduling), reusing the real isNewToken/isFill
-- signal recordArchivalHydration's callers already pass -- no new
-- fingerprinting infra invented, no fabricated volatility score.
ALTER TABLE collection_archival_stats
  ADD COLUMN IF NOT EXISTS consecutive_unchanged integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_due_at timestamptz;
