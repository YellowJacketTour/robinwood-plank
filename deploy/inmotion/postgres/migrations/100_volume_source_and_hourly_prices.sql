-- AUDIT lens 6 #5/#8 (2026-09-06, "one sink, one aggregator").
--
-- volume_source / volume_computed_at give the volume columns provenance so
-- the three vendor writers (opensea-stats, coingecko-nft-stats,
-- rarity-index-runner / hydrate-stats) stop racing the ledger aggregator:
-- when volume_source = 'ledger' and volume_computed_at is fresh, vendor
-- lanes leave the volume/sales columns alone. volume_*_usd is the USD sum
-- of amount_usd over plank_market_events sales (priced at write time).
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_24h_usd NUMERIC;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_7d_usd NUMERIC;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_30d_usd NUMERIC;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_source TEXT;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_computed_at TIMESTAMPTZ;

-- Hourly USD closes per asset symbol (ETH, SOL, BTC, POL, BNB, AVAX, ...)
-- so a sale's amount_usd is "USD at time of sale" (hourly, the Allium/Dune
-- convention -- RESEARCH lens R1 (5)), not today's spot re-applied to
-- history. `source` records where the close came from ('coingecko',
-- 'coinbase', 'spot-fallback', ...).
CREATE TABLE IF NOT EXISTS plank_asset_price_hourly (
  asset TEXT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  usd NUMERIC NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (asset, hour)
);
