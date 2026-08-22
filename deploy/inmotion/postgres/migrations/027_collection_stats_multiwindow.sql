-- Real 7d/30d volume/sales alongside the existing 24h figures on
-- plank_multichain_snapshots. Same source as volume_24h_wei/sales_24h
-- (OpenSea /collections/{slug}/stats -- see rarity-index-runner.ts): that
-- endpoint's `intervals` array already returns "seven_day" and "thirty_day"
-- entries in the SAME response as "one_day", so this is zero extra API
-- calls, just reading more of a response this app already fetches.
--
-- Null, not zero, until a collection has been through the OpenSea stats
-- pass at least once, matching volume_24h_wei/sales_24h's own semantics.
--
-- Deliberately NOT sourced from plank_multichain_activity_stats: that table
-- is transfer-COUNT only (see 015_multichain_activity_stats.sql), with no
-- $ amount per row, so summing it across a window would not produce a real
-- volume figure -- it's already surfaced honestly elsewhere as
-- TrackedCollection.recentActivity, never conflated with $ volume.
--
-- Additive only; a build that has never heard of these columns never
-- queries them.

ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_7d_wei NUMERIC(78, 0);
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS sales_7d INTEGER;
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS volume_30d_wei NUMERIC(78, 0);
ALTER TABLE plank_multichain_snapshots ADD COLUMN IF NOT EXISTS sales_30d INTEGER;
