-- Provider-neutral collection membership checkpoints and raw token traits.
-- A worker advances a bounded page, commits tokens and its next cursor in one
-- transaction, then resumes there on the next tick.  This prevents large
-- collections from repeatedly restarting at page one.

ALTER TABLE plank_collection_tokens
  ADD COLUMN IF NOT EXISTS traits JSONB NOT NULL DEFAULT '[]'::JSONB;

CREATE TABLE IF NOT EXISTS plank_collection_membership_cursors (
  chain_slug TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  source TEXT NOT NULL,
  cursor TEXT,
  expected_count INTEGER CHECK (expected_count IS NULL OR expected_count >= 0),
  observed_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_count >= 0),
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_error TEXT,
  source_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, collection_slug, source)
);

CREATE INDEX IF NOT EXISTS plank_collection_membership_work_idx
  ON plank_collection_membership_cursors (chain_slug, source, complete, updated_at);
