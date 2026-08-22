-- OpenSea safelist / NSFW flags. Fail-closed: NULL means unknown, never
-- treat unknown as verified. No fabricated wash-trade score -- OpenSea
-- does not publish a collection-level wash metric we can store honestly.
ALTER TABLE plank_multichain_snapshots
  ADD COLUMN IF NOT EXISTS safelist_status TEXT,
  ADD COLUMN IF NOT EXISTS is_nsfw BOOLEAN;
