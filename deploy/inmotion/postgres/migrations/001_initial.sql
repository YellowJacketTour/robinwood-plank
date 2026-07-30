CREATE TABLE IF NOT EXISTS plank_kv_values (
  key_name TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS plank_kv_values_expiry_idx
  ON plank_kv_values (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS plank_kv_hash_fields (
  key_name TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_name, field_name)
);

CREATE TABLE IF NOT EXISTS plank_kv_set_members (
  key_name TEXT NOT NULL,
  member_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key_name, member_value)
);

CREATE TABLE IF NOT EXISTS market_orders (
  id TEXT PRIMARY KEY,
  order_kind TEXT NOT NULL CHECK (order_kind IN ('listing', 'offer')),
  collection_slug TEXT NOT NULL,
  maker VARCHAR(42) NOT NULL,
  token_id NUMERIC(78, 0),
  price_wei NUMERIC(78, 0) NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_orders_collection_kind_expiry_idx
  ON market_orders (collection_slug, order_kind, expires_at);

CREATE INDEX IF NOT EXISTS market_orders_collection_kind_price_idx
  ON market_orders (collection_slug, order_kind, price_wei, expires_at);

CREATE INDEX IF NOT EXISTS market_orders_maker_expiry_idx
  ON market_orders (maker, expires_at);

CREATE INDEX IF NOT EXISTS market_orders_token_kind_expiry_idx
  ON market_orders (collection_slug, token_id, order_kind, expires_at);

CREATE TABLE IF NOT EXISTS served_order_hashes (
  order_hash VARCHAR(66) PRIMARY KEY,
  first_served_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS boards_state (
  singleton_id SMALLINT PRIMARY KEY CHECK (singleton_id = 1),
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
