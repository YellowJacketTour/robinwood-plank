-- Unified wallet-risk signal ledger -- v1 of docs/marketplank/GROK-FINDINGS-
-- unified-intelligence-layer-2026-08-25.md's own most-actionable near-term
-- recommendation: today, every real fraud/reputation signal this app
-- produces is discarded at its own feature's boundary (Bad Boards' marks
-- live only in the boards_state JSON blob; the Season 2 $PLANK KOTH
-- fraud-gate pipeline's flags live only in plank_koth_review_queue) -- a
-- wallet flagged by one system is invisible to the other, and any FUTURE
-- feature starts from zero again. This table is the shared, append-only
-- ledger every wallet-risk-producing feature can write to and any
-- wallet-risk-consuming feature can read from, without needing to know
-- which other feature(s) produced a given signal.
--
-- DELIBERATELY NOT a replacement for either existing system's own state --
-- boards_state remains Bad Boards' own source of truth (cooldowns, decay,
-- widget sessions all stay there), plank_koth_review_queue remains the
-- KOTH pipeline's own actionable review workflow. This is an ADDITIVE
-- cross-reference layer: "what has ANY system ever observed about this
-- wallet," queried by severity/source, never a second copy of truth for
-- either existing system's own logic.
CREATE TABLE IF NOT EXISTS wallet_signals (
  id BIGSERIAL PRIMARY KEY,
  wallet TEXT NOT NULL,
  chain_slug TEXT NOT NULL,
  -- e.g. 'bad_boards', 'plank_koth_review' -- an honest label of which
  -- real feature produced this signal, never a fabricated/generic tag.
  source TEXT NOT NULL,
  -- 0..1, this source's own severity for this observation. Never averaged
  -- or combined across sources here -- a consumer reads all rows for a
  -- wallet and applies its own judgment, matching the fraud doc's own
  -- "flag, do not silently combine into one score" discipline.
  severity NUMERIC(3, 2) NOT NULL CHECK (severity >= 0 AND severity <= 1),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wallet_signals_wallet_idx ON wallet_signals (wallet, chain_slug, created_at DESC);
