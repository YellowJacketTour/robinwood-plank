-- Cross-chain, cross-era market evidence. This is the normalized sink for
-- native contracts, exchange protocols, Solana programs, and Bitcoin venues.
-- Raw source payloads remain available for re-decoding; normalized fields are
-- queryable without pretending heterogeneous protocols have identical shapes.
CREATE TABLE IF NOT EXISTS plank_market_events (
  id BIGSERIAL PRIMARY KEY,
  chain_slug TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  protocol_version TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('sale','transfer','mint','burn','listing-created','listing-cancelled','bid-created','bid-cancelled')),
  collection_key TEXT NOT NULL,
  token_id TEXT,
  tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  sub_index INTEGER NOT NULL DEFAULT 0,
  block_number NUMERIC,
  block_timestamp TIMESTAMPTZ,
  seller TEXT,
  buyer TEXT,
  maker TEXT,
  taker TEXT,
  currency_address TEXT,
  currency_symbol TEXT,
  currency_decimals INTEGER,
  amount_atomic NUMERIC,
  amount_usd NUMERIC,
  usd_price_timestamp TIMESTAMPTZ,
  usd_price_source TEXT,
  finality TEXT NOT NULL DEFAULT 'observed' CHECK (finality IN ('observed','confirmed','finalized','reverted')),
  integrity_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_slug, venue_id, tx_hash, event_index, sub_index)
);

CREATE INDEX IF NOT EXISTS plank_market_events_collection_time_idx
  ON plank_market_events (chain_slug, lower(collection_key), block_timestamp DESC);
CREATE INDEX IF NOT EXISTS plank_market_events_token_time_idx
  ON plank_market_events (chain_slug, lower(collection_key), token_id, block_timestamp DESC);
CREATE INDEX IF NOT EXISTS plank_market_events_venue_block_idx
  ON plank_market_events (chain_slug, venue_id, block_number DESC);

CREATE TABLE IF NOT EXISTS plank_market_coverage (
  chain_slug TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  protocol_version TEXT NOT NULL DEFAULT '',
  capability TEXT NOT NULL CHECK (capability IN ('sales','transfers','listings','bids')),
  status TEXT NOT NULL CHECK (status IN ('indexed','partial','planned','unavailable','error')),
  start_block NUMERIC,
  indexed_through_block NUMERIC,
  start_timestamp TIMESTAMPTZ,
  indexed_through_timestamp TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, venue_id, protocol_version, capability)
);

COMMENT ON TABLE plank_market_coverage IS
  'Truthful source coverage. Missing/partial adapters are unknown coverage, never zero market activity.';

CREATE TABLE IF NOT EXISTS plank_market_live_orders (
  chain_slug TEXT NOT NULL,
  venue_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('ask','bid')),
  collection_key TEXT NOT NULL,
  token_id TEXT,
  maker TEXT NOT NULL,
  currency_address TEXT,
  currency_symbol TEXT,
  currency_decimals INTEGER,
  amount_atomic NUMERIC NOT NULL,
  amount_usd NUMERIC,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_order JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chain_slug, venue_id, order_id)
);

CREATE INDEX IF NOT EXISTS plank_market_live_orders_collection_side_price_idx
  ON plank_market_live_orders (chain_slug, lower(collection_key), side, amount_atomic);
