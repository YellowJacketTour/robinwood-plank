-- Genesis-forward per-mint cursor for the Solana NFT transfer scanner
-- (lib/market/multichain/discovery/helius-transfer-scan.ts).
--
-- WHY NO NEW EVENT TABLE: plank_market_events (migration 042) plus its
-- migration-046 chain_namespace/event_identity columns are ALREADY a
-- chain-agnostic transfer/sale/mint ledger, explicitly anticipating Solana
-- (046's own UPDATE branches on chain_slug LIKE 'solana%'). Building a
-- second, parallel Solana-only event table would duplicate that schema and
-- immediately drift from it. The Solana transfer scanner writes into
-- plank_market_events directly (chain_namespace='solana', chain_slug=
-- 'solana-mainnet'), the same sink transfer-ledger.ts already uses for EVM.
-- What Solana genuinely lacks and this migration adds is resumable,
-- per-mint pagination state: Helius's Enhanced Transactions API
-- (GET /v0/addresses/{address}/transactions) is walked per real member
-- mint (there is no collection-wide "give me every transfer for every
-- member" endpoint), one signature cursor per mint, mirroring the same
-- "commit rows + next cursor together, resume forward" shape
-- plank_collection_membership_cursors (migration 036) already established
-- for DAS membership paging -- scoped to (chain_slug, mint, source) instead
-- of (chain_slug, collection_slug, source) since here the resumable unit is
-- one mint's own transaction history, not a collection page.
CREATE TABLE IF NOT EXISTS plank_solana_transfer_scan_cursors (
  chain_slug TEXT NOT NULL,
  mint TEXT NOT NULL,
  collection_slug TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'helius-enhanced-tx',
  after_signature TEXT,
  oldest_reached BOOLEAN NOT NULL DEFAULT FALSE,
  events_written INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_slug, mint, source)
);

CREATE INDEX IF NOT EXISTS plank_solana_transfer_scan_work_idx
  ON plank_solana_transfer_scan_cursors (chain_slug, source, oldest_reached, updated_at);

CREATE INDEX IF NOT EXISTS plank_solana_transfer_scan_collection_idx
  ON plank_solana_transfer_scan_cursors (chain_slug, lower(collection_slug));
