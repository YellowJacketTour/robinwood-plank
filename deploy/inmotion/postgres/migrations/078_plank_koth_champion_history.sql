-- "Fallen champions" -- a real historical record of every wallet that WAS
-- the #1 leading buy before being dethroned by a bigger one. Before this,
-- plank-koth.ts's own applyCandidateSale simply OVERWRITES leading_tx_hash
-- et al. in place -- the previous leader's own record is discarded the
-- instant a new one lands, with nothing anywhere remembering who used to
-- hold the crown. This table is purely additive history -- it never feeds
-- back into king-of-the-hill-rules.ts's own decision, it only remembers
-- what that engine already decided, for real display purposes.
CREATE TABLE IF NOT EXISTS plank_koth_champion_history (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  eth_paid_wei NUMERIC(78, 0) NOT NULL,
  plank_amount NUMERIC(78, 0) NOT NULL,
  usd_value_at_buy NUMERIC(20, 2),
  became_champion_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL while this is still the reigning champion; set the instant a
  -- bigger real buy dethrones it. The reigning champion is always the one
  -- row with dethroned_at IS NULL (there is ever at most one, by
  -- construction -- see plank-koth.ts's own write path).
  dethroned_at TIMESTAMPTZ,
  dethroned_by_tx_hash TEXT
);
CREATE INDEX IF NOT EXISTS plank_koth_champion_history_reign_idx
  ON plank_koth_champion_history (became_champion_at DESC);
