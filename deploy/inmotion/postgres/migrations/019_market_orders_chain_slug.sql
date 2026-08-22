-- Extends market_orders (previously Robinhood-Chain-only by omission) to
-- carry which chain an order actually lives on, so the same table and the
-- same store/validate functions can serve Marketplank-native listings on
-- the 7 foreign EVM chains too, not just Robinhood Chain -- see
-- lib/market/multichain/trading/foreign-chain-registry.ts for the real
-- chain list. DEFAULT 'robinhood'/4663 backfills every existing row
-- correctly with no UPDATE needed: every row written before this migration
-- really is a Robinhood-Chain order. Same chain_slug/chain_id column
-- convention as plank_multichain_collections (migration 013), so the same
-- foreignChainByChainSlug() lookups work against both tables.
ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS chain_slug TEXT NOT NULL DEFAULT 'robinhood';
ALTER TABLE market_orders ADD COLUMN IF NOT EXISTS chain_id BIGINT NOT NULL DEFAULT 4663;

CREATE INDEX IF NOT EXISTS market_orders_chain_collection_kind_expiry_idx
  ON market_orders (chain_slug, collection_slug, order_kind, expires_at);

CREATE INDEX IF NOT EXISTS market_orders_chain_kind_idx
  ON market_orders (chain_slug, order_kind);
