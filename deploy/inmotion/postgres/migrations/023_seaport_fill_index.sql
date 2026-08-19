-- Self-hosted, on-chain Seaport OrderFulfilled fill index -- the real,
-- independent cross-marketplace volume/floor/activity data source this app
-- did not previously have.
--
-- WHY THIS EXISTS
-- ----------------
-- The two major third-party NFT order-aggregator APIs this ecosystem relied
-- on both shut down: Reservoir Protocol (2025-10-15) and SimpleHash
-- (2026-03-27, folded into Phantom). Neither OpenSea's nor Magic Eden's ToS
-- permits scraping/redistributing their listing data for a competing
-- product. On-chain data carries no such restriction -- an OrderFulfilled
-- event is public chain state, not a gated API response. This table is
-- this app's own, real, first-party record of every Seaport fill it
-- observes, across every chain it trades on, watched directly by address
-- (Seaport is deployed at the identical address on every chain -- see
-- foreign-chain-registry.ts's own header) rather than depending on any
-- third party's willingness to keep operating.
--
-- REUSES THE PROVEN chain-indexer.ts SKELETON, NOT A NEW PATTERN
-- ------------------------------------------------------------------
-- Cursor-per-chain, confirmed-head-only writes, idempotent
-- (chain_slug, tx_hash, log_index) uniqueness -- the exact same shape
-- 008_chain_events.sql already established and this codebase's own indexer
-- already proved correct in production. See
-- lib/market/multichain/seaport-fill-indexer.ts, which imports
-- planScan/confirmedHead from chain-indexer.ts directly rather than
-- reimplementing the same range math a second time.
--
-- SCOPE: FORWARD-ONLY FROM FIRST RUN, NOT A HISTORICAL BACKFILL
-- -------------------------------------------------------------------
-- Each chain's cursor bootstraps from that chain's head at first run, not
-- Seaport's real deployment block -- an 8-chain historical backfill would
-- need each chain's actual first-relevant-block researched individually
-- (a real, separate, larger undertaking), and starting live-forward is
-- honest about what this ships with today rather than silently claiming
-- complete history. Documented here, not hidden.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_seaport_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  order_hash      TEXT NOT NULL,
  seller          TEXT NOT NULL,   -- OrderFulfilled.offerer, lowercased
  buyer           TEXT NOT NULL,   -- OrderFulfilled.recipient, lowercased

  -- The traded NFT -- the first ERC-721/ERC-1155 item found across offer
  -- and consideration (whichever side carries it; a listing has it in
  -- offer, a bid has it in consideration). NULL only for the rare fill
  -- with no NFT item at all (e.g. a pure token-for-token order Seaport
  -- also supports but this app never produces) -- kept as a real row
  -- rather than dropped, so volume totals stay complete.
  nft_contract    TEXT,
  token_id        NUMERIC(78, 0),

  -- The monetary leg -- the first NATIVE/ERC-20 item found, whichever side
  -- carries it. currency_token NULL means native gas token.
  currency_token  TEXT,
  price_wei       NUMERIC(78, 0),

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_seaport_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_seaport_fills_collection_idx
  ON plank_seaport_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_seaport_fills_block_idx
  ON plank_seaport_fills (chain_slug, block_number DESC);

-- One row per chain -- same shape as plank_chain_index_cursor and
-- plank_multichain_discovery_cursor (migrations 008/014), deliberately a
-- SEPARATE table rather than reusing either: this indexer watches a
-- DIFFERENT log (Seaport OrderFulfilled, address-filtered) than both of
-- those (collection Transfer / vault events; unfiltered Transfer
-- discovery respectively), so sharing a cursor table would conflate three
-- independent scan positions under one key space.
CREATE TABLE IF NOT EXISTS plank_seaport_fill_cursor (
  chain_slug        TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
