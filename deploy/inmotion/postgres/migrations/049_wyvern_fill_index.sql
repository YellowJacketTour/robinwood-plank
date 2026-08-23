-- Self-hosted, on-chain Wyvern Exchange OrdersMatched fill index -- same
-- rationale as 023_seaport_fill_index.sql's own header (real, first-party
-- on-chain history, not a scraped or third-party-API-dependent one), for
-- OpenSea's PRE-Seaport marketplace contract (2018-2022).
--
-- WHY A SEPARATE TABLE, NOT plank_seaport_fills
-- ----------------------------------------------------------------------
-- Wyvern's OrdersMatched event is real but structurally thinner than
-- Seaport's OrderFulfilled: `event OrdersMatched(bytes32 buyHash,
-- bytes32 sellHash, address indexed maker, address indexed taker,
-- uint256 price, bytes32 indexed metadata)` (ProjectWyvern/wyvern-ethereum,
-- contracts/exchange/ExchangeCore.sol) carries the matched price and the
-- two counterparties, but -- unlike Seaport -- NOT the traded NFT contract
-- or token id. Those only exist inside the atomicMatch_ call's ABI-encoded
-- calldata (the buy/sell Order structs), which this indexer does not
-- decode (a materially larger, separate undertaking: reconstructing two
-- full Order structs from raw calldata bytes per Wyvern's own
-- exchange-core matching rules). Reusing plank_seaport_fills's schema
-- would force either a fabricated nft_contract/token_id or a misleading
-- reuse of a column that means something different here. This table is
-- honest about the real shape of what OrdersMatched actually proves:
-- a real, on-chain confirmed trade between maker and taker at a given
-- price, with the asset identity intentionally left NULL rather than
-- guessed.
--
-- SCOPE: DUAL-CURSOR (live-forward + genesis-backfill), SAME PATTERN AS
-- plank_seaport_fill_cursor -- see hypersync-wyvern-scan.ts.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_wyvern_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  deployment_address TEXT,          -- which Wyvern generation (v1/v2) emitted this log
  protocol_version    TEXT,         -- "1" | "2", from wyvernVersionForAddress

  buy_hash        TEXT NOT NULL,
  sell_hash       TEXT NOT NULL,
  maker           TEXT NOT NULL,    -- OrdersMatched.maker, lowercased
  taker           TEXT NOT NULL,    -- OrdersMatched.taker, lowercased
  price_wei       NUMERIC(78, 0) NOT NULL,
  metadata        TEXT,             -- OrdersMatched.metadata, raw bytes32 hex

  -- Deliberately NULL: not derivable from the event alone (see header).
  nft_contract    TEXT,
  token_id        NUMERIC(78, 0),

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_wyvern_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_wyvern_fills_block_idx
  ON plank_wyvern_fills (chain_slug, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_wyvern_fills_maker_idx
  ON plank_wyvern_fills (chain_slug, maker, block_number DESC);

-- One row per cursor key -- same shape/reasoning as
-- plank_seaport_fill_cursor (a live-forward key and a genesis-backfill key
-- are independent rows under this one table, same as that indexer's own
-- ":seaport-all-live-v1" / ":seaport-all-genesis-v1" namespacing).
CREATE TABLE IF NOT EXISTS plank_wyvern_fill_cursor (
  cursor_key        TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
