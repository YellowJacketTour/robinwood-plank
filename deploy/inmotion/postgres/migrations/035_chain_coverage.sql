-- Auditable chain-history coverage. Cursors answer "where will the next call
-- start?"; these rows answer the different correctness question "what
-- contiguous range has actually been observed, and how far is it from head?"
CREATE TABLE IF NOT EXISTS plank_chain_coverage (
  chain_slug TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('historical', 'forward', 'priority')),
  standard_group TEXT NOT NULL,
  range_start BIGINT NOT NULL CHECK (range_start >= 0),
  next_block BIGINT NOT NULL CHECK (next_block >= range_start),
  target_block BIGINT,
  observed_head BIGINT,
  state TEXT NOT NULL CHECK (state IN ('backfilling', 'live', 'complete', 'stalled', 'unavailable')),
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, lane, standard_group)
);

CREATE INDEX IF NOT EXISTS plank_chain_coverage_state_idx
  ON plank_chain_coverage (state, updated_at);
