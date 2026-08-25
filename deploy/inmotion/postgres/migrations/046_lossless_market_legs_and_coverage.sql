-- Lossless fulfillment storage. The parent event is the observation; child
-- legs preserve every asset and payment without assigning a bundle's total to
-- the first NFT or summing unlike currencies.
CREATE TABLE IF NOT EXISTS plank_market_event_assets (
  chain_slug TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  protocol_version TEXT,
  deployment_address TEXT,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  leg_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('offer','consideration')),
  item_type INTEGER NOT NULL,
  token_address TEXT,
  token_id TEXT,
  amount_atomic NUMERIC NOT NULL,
  recipient TEXT,
  PRIMARY KEY (chain_slug, venue_id, tx_hash, event_index, side, leg_index)
);

CREATE TABLE IF NOT EXISTS plank_market_event_payments (
  chain_slug TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  protocol_version TEXT,
  deployment_address TEXT,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL,
  leg_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('offer','consideration')),
  token_address TEXT,
  amount_atomic NUMERIC NOT NULL,
  recipient TEXT,
  allocation_method TEXT NOT NULL DEFAULT 'unallocated'
    CHECK (allocation_method IN ('unallocated','protocol-explicit','equal','pro-rata')),
  amount_usd NUMERIC,
  usd_price_timestamp TIMESTAMPTZ,
  usd_price_source TEXT,
  PRIMARY KEY (chain_slug, venue_id, tx_hash, event_index, side, leg_index)
);

COMMENT ON COLUMN plank_market_event_payments.allocation_method IS
  'Bundle payment is unallocated unless the protocol explicitly supplies an item allocation. Equal/pro-rata are analytical projections and must remain labeled.';

-- Runtime truth is scoped to exactly one chain, venue, protocol version and
-- capability. Static adapter support and observed completeness are distinct.
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS observed_head NUMERIC;
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS indexed_from_identity TEXT;
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS indexed_through_identity TEXT;
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS evidence_source TEXT;
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS freshness_seconds INTEGER;
ALTER TABLE plank_market_coverage ADD COLUMN IF NOT EXISTS completeness_proof JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Additive canonical identity for non-EVM event coordinates (Solana
-- instruction paths and Bitcoin input/output/order revisions).
ALTER TABLE plank_market_events ADD COLUMN IF NOT EXISTS chain_namespace TEXT;
ALTER TABLE plank_market_events ADD COLUMN IF NOT EXISTS event_identity TEXT;
UPDATE plank_market_events
SET chain_namespace = CASE
  WHEN chain_slug LIKE 'solana%' THEN 'solana'
  WHEN chain_slug LIKE 'bitcoin%' THEN 'bitcoin'
  ELSE 'eip155'
END,
event_identity = CONCAT(chain_slug, ':', tx_hash, ':', event_index, ':', sub_index)
WHERE chain_namespace IS NULL OR event_identity IS NULL;
ALTER TABLE plank_market_events ALTER COLUMN chain_namespace SET NOT NULL;
ALTER TABLE plank_market_events ALTER COLUMN event_identity SET NOT NULL;
CREATE INDEX IF NOT EXISTS plank_market_events_scoped_identity_idx
  ON plank_market_events (chain_namespace, chain_slug, event_identity);
