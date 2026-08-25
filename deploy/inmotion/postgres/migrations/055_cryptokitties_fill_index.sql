-- Self-hosted, on-chain CryptoKitties SaleClockAuction/SiringClockAuction
-- AuctionSuccessful fill index -- same rationale as 049_wyvern_fill_index.sql's
-- own header (real, first-party on-chain history, not a scraped or
-- third-party-API-dependent one), for CryptoKitties' own PRE-Wyvern native
-- auction houses (2017-11 launch, over half a year before Wyvern's 2018
-- debut, so genuinely un-capturable by any generic Seaport/Wyvern/etc.
-- fill-indexer in this app).
--
-- WHY A SEPARATE TABLE, NOT plank_wyvern_fills
-- ----------------------------------------------------------------------
-- AuctionSuccessful's real signature -- `event AuctionSuccessful(uint256
-- tokenId, uint256 totalPrice, address winner)` (dapperlabs/cryptokitties-bounty,
-- contracts/Auction/ClockAuctionBase.sol) -- carries the kitty id, the
-- winning bid, and the winner directly (unlike Wyvern's OrdersMatched,
-- which omits the asset entirely). It has the opposite gap: no seller
-- address. Reusing plank_wyvern_fills's schema would misrepresent a known
-- token_id as unknown; this table is honest about the real shape of what
-- AuctionSuccessful actually proves -- a real, on-chain confirmed sale or
-- siring-rights purchase of a specific, known kitty at a known price, with
-- the seller intentionally left NULL rather than guessed (see
-- cryptokitties-fill-indexer.ts's header for why recovering it would need a
-- separate AuctionCreated join this indexer does not attempt).
--
-- auction_kind distinguishes a real ownership-transferring sale
-- ('sale', via SaleClockAuction) from a real but non-transferring
-- breeding-rights purchase ('siring', via SiringClockAuction) -- both are
-- real priced on-chain activity for the collection, but only 'sale' rows
-- are actual transfers. A reader that wants strict transfer history must
-- filter on auction_kind = 'sale'.
--
-- SCOPE: DUAL-CURSOR (live-forward + genesis-backfill), SAME PATTERN AS
-- plank_wyvern_fill_cursor -- see hypersync-cryptokitties-scan.ts.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_cryptokitties_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  deployment_address TEXT NOT NULL,  -- SaleClockAuction or SiringClockAuction address, lowercased
  auction_kind        TEXT NOT NULL, -- 'sale' | 'siring'

  nft_contract    TEXT NOT NULL,     -- KittyCore, 0x06012c8cf97bead5deae237070f9587f8e7a266d
  token_id        NUMERIC(78, 0) NOT NULL,
  winner          TEXT NOT NULL,     -- AuctionSuccessful.winner, lowercased
  total_price_wei NUMERIC(78, 0) NOT NULL,

  -- Deliberately NULL: not derivable from AuctionSuccessful alone (see header).
  seller          TEXT,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_cryptokitties_fills_unique UNIQUE (chain_slug, tx_hash, log_index),
  CONSTRAINT plank_cryptokitties_fills_kind_check CHECK (auction_kind IN ('sale', 'siring'))
);

CREATE INDEX IF NOT EXISTS plank_cryptokitties_fills_block_idx
  ON plank_cryptokitties_fills (chain_slug, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_cryptokitties_fills_token_idx
  ON plank_cryptokitties_fills (nft_contract, token_id, block_number DESC);

-- One row per cursor key -- same shape/reasoning as
-- plank_wyvern_fill_cursor (a live-forward key and a genesis-backfill key
-- are independent rows under this one table, same as that indexer's own
-- ":cryptokitties-all-live-v1" / ":cryptokitties-all-genesis-v1" namespacing).
CREATE TABLE IF NOT EXISTS plank_cryptokitties_fill_cursor (
  cursor_key        TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
