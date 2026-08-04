-- Permanent, append-only on-chain event ledger.
--
-- WHY THIS EXISTS
-- ---------------
-- Until this table, every Activity read did a LIVE Blockscout/RPC fan-out on
-- each request (lib/market/activity.ts `fetchActivity`), hard-capped at 40
-- events by default and 800 in `full=1` mode (FULL_LINEAGE_LIMIT). Those caps
-- are not tunable knobs: the free RPC tier hard-fails a wide unfiltered
-- eth_getLogs with "logs matched by query exceeds limit of 10000", and each
-- displayed row costs extra per-tx enrichment round-trips. The consequence is
-- architectural, not cosmetic — anything older than that sliding window has no
-- record anywhere in the app and becomes permanently invisible. A real 0.11 ETH
-- sale was reported missing from the Activity feed for exactly this reason
-- while being fully present on-chain.
--
-- The fix is the same one Reservoir/Ponder-style indexers apply, minus the
-- always-on daemon this hosting cannot run (InMotion/Passenger has no
-- long-lived process, so websockets and provider webhooks are both off the
-- table): keep a permanent ledger, and advance a stored cursor from the
-- existing 2-minute cron. Backfill and live-sync are then literally the same
-- code path — only the starting cursor differs.
--
-- IDEMPOTENCY
-- -----------
-- (tx_hash, log_index) is globally unique for a log on an EVM chain, so the
-- UNIQUE constraint below makes re-indexing any block range a no-op. That is
-- what lets the cron re-scan overlapping ranges freely (after a crash, a
-- partial run, or a deliberate reorg rewind) without ever duplicating a row.
--
-- REORG SAFETY
-- ------------
-- Rows are written for blocks at or below a confirmed head only — see
-- CONFIRMATION_DEPTH_BLOCKS in lib/market/chain-indexer.ts. `confirmed` is
-- carried on the row so a future release can add an optimistic
-- ahead-of-confirmation lane without a second migration or a schema change.
--
-- COMPATIBILITY
-- -------------
-- Purely additive. The immediately previous release never queries either table
-- and is unaffected by their presence.

CREATE TABLE IF NOT EXISTS plank_chain_events (
  id BIGSERIAL PRIMARY KEY,

  -- Chain coordinates. The unique pair is the idempotency key.
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  -- Which indexed log source produced this row: 'nft' (the collection's own
  -- ERC-721 Transfer log) or 'vault' (a MarketplankVault trade/LP event).
  source TEXT NOT NULL,
  -- Lowercased address of the contract that EMITTED the log.
  contract TEXT NOT NULL,

  -- Event shapes already computed by the live-fetch code this ledger replaces
  -- the read path of: ActivityKind ('mint' | 'sale' | 'transfer') from
  -- lib/market/activity.ts, and VaultTradeKind ('buy' | 'sell' | 'deposit' |
  -- 'redeem' | 'add_lp' | 'remove_lp') from lib/market/vault-activity.ts.
  kind TEXT NOT NULL,
  token_id TEXT,
  from_address TEXT,
  to_address TEXT,

  -- NUMERIC(78,0) holds any uint256 exactly. A BIGINT would silently overflow
  -- and TEXT would make ORDER BY price wrong (lexicographic), so neither is an
  -- option for a value the "highest sale" surfaces read.
  price_wei NUMERIC(78, 0),
  shares_wei NUMERIC(78, 0),

  -- Which contract executed the trade, mirroring ActivityEvent.venue.
  -- 'marketplank' | 'seaport' | 'vault' | 'other', or NULL for a plain
  -- wallet-to-wallet move.
  venue_kind TEXT,
  venue_contract TEXT,

  -- False would mean "written ahead of the confirmation depth". Nothing writes
  -- false today; see the reorg note above.
  confirmed BOOLEAN NOT NULL DEFAULT TRUE,

  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_chain_events_tx_log_unique UNIQUE (tx_hash, log_index)
);

-- The Activity feed's only ordering: newest first, paginated.
CREATE INDEX IF NOT EXISTS plank_chain_events_order_idx
  ON plank_chain_events (block_number DESC, log_index DESC);

-- Per-source feeds (collection activity vs vault trade history) and the
-- indexer's own "highest block I already have" sanity check.
CREATE INDEX IF NOT EXISTS plank_chain_events_source_block_idx
  ON plank_chain_events (source, block_number DESC);

-- Per-token lineage (the item-detail price chart).
CREATE INDEX IF NOT EXISTS plank_chain_events_token_idx
  ON plank_chain_events (token_id, block_number DESC)
  WHERE token_id IS NOT NULL;

-- Sale-only reads (volume, highest sale) skip the mint/transfer bulk.
CREATE INDEX IF NOT EXISTS plank_chain_events_kind_idx
  ON plank_chain_events (kind, block_number DESC);

-- Resumable cursor, one row per indexed contract/topic pair.
--
-- `last_indexed_block` is the highest block fully covered by a completed
-- scan. It only ever advances (enforced in lib/market/chain-events.ts), so a
-- concurrent Passenger worker holding a staler value can never walk it back
-- and cause the next run to skip blocks it never actually read.
CREATE TABLE IF NOT EXISTS plank_chain_index_cursor (
  source_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  contract TEXT NOT NULL,
  last_indexed_block BIGINT NOT NULL,
  head_block BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
