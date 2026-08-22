-- Real 24h floor-change percentage from a source that actually reports
-- 24h change (CoinGecko NFT detail), plus room for the same number when
-- this app's own previous_floor_price_wei is a true ~24h-old observation.
-- Null until written; never default 0.

ALTER TABLE plank_multichain_snapshots
  ADD COLUMN IF NOT EXISTS floor_change_pct DOUBLE PRECISION;
