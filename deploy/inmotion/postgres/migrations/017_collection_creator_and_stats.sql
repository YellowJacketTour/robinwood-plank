-- Creator/artist attribution ("whenever provided", never fabricated) and
-- real volume/floor-change tracking for the Global Market hub's card
-- display -- see rarity-index-runner.ts for what populates these and why
-- (OpenSea's creator_username field is null site-wide now; twitter_username
-- and owner wallet are the reliably-populated real fields, confirmed live
-- 2026-08-18 across multiple collections).
ALTER TABLE plank_multichain_collections ADD COLUMN IF NOT EXISTS creator_handle TEXT;
ALTER TABLE plank_multichain_collections ADD COLUMN IF NOT EXISTS creator_address TEXT;

-- volume_24h_wei/sales_24h: real OpenSea /collections/{slug}/stats data,
-- not fabricated. previous_floor_price_wei: this app's OWN last-observed
-- floor (set from the prior value before each overwrite), so a real
-- floor % change can be computed from actual history this app recorded --
-- OpenSea's stats endpoint has no floor-change field at all (confirmed
-- live), so there was no live-data shortcut available for this one.
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_24h_wei NUMERIC(78, 0);
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS sales_24h INTEGER;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS previous_floor_price_wei NUMERIC(78, 0);
