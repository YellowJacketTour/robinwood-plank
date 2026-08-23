-- Durable, bounded metadata-enrichment state. Absence of image/traits no
-- longer means either "not attempted" or "the contract has none".
ALTER TABLE plank_collection_tokens
  ADD COLUMN IF NOT EXISTS metadata_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (metadata_state IN ('pending', 'complete', 'empty', 'retry')),
  ADD COLUMN IF NOT EXISTS metadata_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata_error TEXT;

CREATE INDEX IF NOT EXISTS plank_collection_tokens_metadata_work_idx
  ON plank_collection_tokens (chain_slug, metadata_state, metadata_attempted_at NULLS FIRST)
  WHERE metadata_state IN ('pending', 'retry');
