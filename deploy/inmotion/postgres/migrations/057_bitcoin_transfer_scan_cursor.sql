-- Forward-only global scan cursor for the Bitcoin inscription transfer
-- scanner (lib/market/multichain/discovery/unisat-transfer-scan.ts).
--
-- WHY NO NEW EVENT TABLE: same decision migration 056 already made for
-- Solana. plank_market_events (migration 042) plus its migration-046
-- chain_namespace/event_identity columns already have a `WHEN chain_slug
-- LIKE 'bitcoin%' THEN 'bitcoin'` branch waiting for a writer. This
-- migration adds only the resumable pagination state the writer needs.
--
-- WHY THE CURSOR SHAPE DIFFERS FROM 056 (single row, not per-inscription)
-- ------------------------------------------------------------------------
-- UniSat's real Inscription Indexer (open-api.unisat.io, confirmed live via
-- unisat-collections.ts and unisat-ordinals-trade.ts this session) exposes
-- GET /v1/indexer/inscription/events?start&end&cursor&size -- mint and
-- transfer events by BLOCK HEIGHT RANGE across the entire chain, with no
-- per-inscription or per-collection filter. There is no per-mint walk to do
-- here the way Helius's per-address Enhanced Transactions API required in
-- 056 -- the only resumable unit is "how far forward through block height
-- has this scan gotten," so a single global row is the correct and honest
-- shape, not an artificially narrowed one.
--
-- SCOPE: FORWARD-ONLY FROM FIRST RUN, NOT A HISTORICAL BACKFILL -- same
-- documented, honest limitation 023_seaport_fill_index.sql established:
-- cursor bootstraps at the chain tip on first run, not genesis. A real
-- historical backfill of every inscription transfer since Ordinals launched
-- (block ~767430) is a separate, much larger undertaking.
--
-- Additive only; a build that has never heard of this table never queries it.
CREATE TABLE IF NOT EXISTS plank_bitcoin_transfer_scan_cursor (
  source TEXT PRIMARY KEY DEFAULT 'unisat-inscription-indexer',
  next_start_height NUMERIC,
  events_written INTEGER NOT NULL DEFAULT 0,
  events_skipped_marketplace INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
