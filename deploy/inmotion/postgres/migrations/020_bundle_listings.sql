-- Marketplank-native bundle listings (sell 2+ NFTs from the same collection
-- as one signed Seaport order, one combined price) -- a genuinely different
-- shape from market_orders (whose token_id column assumes exactly one
-- token per order, see lib/market/order-validation.ts's validateListingOrder),
-- so this is a NEW, separate table rather than a schema change to
-- market_orders. Same chain_slug/chain_id convention as
-- plank_multichain_collections (migration 013) and market_orders'
-- own migration 019 addition.
CREATE TABLE IF NOT EXISTS market_bundle_listings (
  id TEXT PRIMARY KEY,
  chain_slug TEXT NOT NULL,
  chain_id BIGINT NOT NULL,
  collection_slug TEXT NOT NULL,
  maker VARCHAR(42) NOT NULL,
  token_ids JSONB NOT NULL,
  price_wei NUMERIC(78, 0) NOT NULL,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_bundle_listings_chain_collection_expiry_idx
  ON market_bundle_listings (chain_slug, collection_slug, expires_at);

CREATE INDEX IF NOT EXISTS market_bundle_listings_maker_expiry_idx
  ON market_bundle_listings (maker, expires_at);
