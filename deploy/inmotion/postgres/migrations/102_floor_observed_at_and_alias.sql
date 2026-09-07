-- AUDIT lens 1 #7/#8 (2026-09-06, Batch E).
--
-- floor_observed_at: when the floor_price_wei column was last written from a
-- real floor observation. synced_at is bumped by every partial writer
-- (supply, holders, sync errors) so it cannot say how old the FLOOR is; the
-- hub freshness dot and DataSourceChip now read this column instead.
--
-- floor_miss_count: consecutive times the authoritative source named in
-- floor_price_marketplace returned no floor (null / 404). At 2 the floor is
-- nulled (a delisted collection must not keep a stale floor forever).
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS floor_observed_at TIMESTAMPTZ;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS floor_miss_count INTEGER NOT NULL DEFAULT 0;
-- Existing floors were observed no later than their last sync; seed from
-- synced_at once so the hub does not flip every row to "never observed".
UPDATE plank_multichain_snapshots SET floor_observed_at = synced_at
 WHERE floor_observed_at IS NULL AND floor_price_wei IS NOT NULL AND floor_price_wei <> '0';

-- alias_symbol: a Helius-discovered Solana row is keyed by its collection
-- asset id (a mint-like address) which no marketplace stats API accepts.
-- Its Magic Eden symbol lives here; floor/listed/holders route through the
-- ME adapter by alias, and CoinGecko matches on alias/slug, never the mint.
ALTER TABLE plank_multichain_collections ADD COLUMN IF NOT EXISTS alias_symbol TEXT;
CREATE INDEX IF NOT EXISTS plank_multichain_collections_alias_symbol_idx
  ON plank_multichain_collections (chain_slug, alias_symbol) WHERE alias_symbol IS NOT NULL;
