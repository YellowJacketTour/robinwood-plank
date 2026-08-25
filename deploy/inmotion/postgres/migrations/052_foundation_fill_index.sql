-- Self-hosted, on-chain Foundation Market fill index -- same rationale as
-- 023_seaport_fill_index.sql's own header (real first-party on-chain
-- history, no third-party API dependency), for the first real historic
-- marketplace covered this pass with zero prior indexing in this repo
-- (Sudoswap and Rarible were also researched this pass; see venue-registry.ts
-- notes for why they are NOT built -- both have real, verified,
-- parameterless/thin on-chain events that cannot be decoded to a fill from
-- log data alone).
--
-- ADDRESS / EVENT SOURCE (cited, not guessed, 2026-08-23 research pass)
-- ----------------------------------------------------------------------
-- FNDNFTMarket proxy address 0xcDA72070E455bb31C7690a170224Ce43623d0B6f,
-- eth-mainnet (chain id 1) -- Foundation's own addresses.js in their
-- official open-source repo, https://github.com/f8n/fnd-protocol
-- (module.exports.prod[1].nftMarket), cross-confirmed by Etherscan's own
-- "Foundation: Market" label at the identical address (independent search
-- hit, 2026-08-23).
--
-- Event signatures copied verbatim from Foundation's own published source,
-- same repo, contracts/mixins/nftMarket/:
--   NFTMarketBuyPrice.sol:
--     event BuyPriceAccepted(address indexed nftContract, uint256 indexed
--       tokenId, address indexed seller, address buyer, uint256 totalFees,
--       uint256 creatorRev, uint256 sellerRev);
--   NFTMarketOffer.sol:
--     event OfferAccepted(address indexed nftContract, uint256 indexed
--       tokenId, address indexed buyer, address seller, uint256 totalFees,
--       uint256 creatorRev, uint256 sellerRev);
--   NFTMarketReserveAuction.sol:
--     event ReserveAuctionCreated(address indexed seller, address indexed
--       nftContract, uint256 indexed tokenId, uint256 duration,
--       uint256 extensionDuration, uint256 reservePrice, uint256 auctionId);
--     event ReserveAuctionFinalized(uint256 indexed auctionId, address
--       indexed seller, address indexed bidder, uint256 totalFees,
--       uint256 creatorRev, uint256 sellerRev);
--
-- HONEST SHAPE NOTE: ReserveAuctionFinalized does NOT carry nftContract/
-- tokenId/price directly -- only an auctionId. This indexer resolves those
-- by also decoding ReserveAuctionCreated (same contract, scanned in the
-- same pass) into a small auctionId -> (nftContract, tokenId, reservePrice)
-- lookup table below, populated genesis-forward so creation rows exist
-- before their matching finalization in any full backfill. A
-- ReserveAuctionFinalized log whose auctionId has no matching creation row
-- yet (e.g. mid-range live-forward lane before the creation range has been
-- scanned) is written with nft_contract/token_id left NULL rather than
-- guessed -- same "NULL over fabrication" stance plank_wyvern_fills uses.
-- price_wei for a finalized auction is the winning bid amount, which
-- ReserveAuctionFinalized also does not carry directly (totalFees +
-- creatorRev + sellerRev sums back to it exactly, since Foundation's fee
-- model takes those three cuts from the winning bid) -- computed here as
-- that sum rather than sourced from a bid-placement event, which is
-- documented in the app column below.
--
-- Additive only; a build that has never heard of these tables never queries them.

CREATE TABLE IF NOT EXISTS plank_foundation_auction_lookup (
  auction_id      NUMERIC(78, 0) PRIMARY KEY,
  chain_slug      TEXT NOT NULL,
  nft_contract    TEXT NOT NULL,
  token_id        NUMERIC(78, 0) NOT NULL,
  seller          TEXT NOT NULL,
  reserve_price   NUMERIC(78, 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plank_foundation_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  event_name      TEXT NOT NULL CHECK (event_name IN ('BuyPriceAccepted','OfferAccepted','ReserveAuctionFinalized')),
  auction_id      NUMERIC(78, 0),   -- only set for ReserveAuctionFinalized

  seller          TEXT NOT NULL,
  buyer           TEXT NOT NULL,

  -- NULL only possible for ReserveAuctionFinalized when the matching
  -- ReserveAuctionCreated row had not yet been indexed -- see header.
  nft_contract    TEXT,
  token_id        NUMERIC(78, 0),

  total_fees      NUMERIC(78, 0) NOT NULL,
  creator_rev     NUMERIC(78, 0) NOT NULL,
  seller_rev      NUMERIC(78, 0) NOT NULL,
  -- price_wei = total_fees + creator_rev + seller_rev in every case, all
  -- three of Foundation's own real fee-split legs on top of the sale price.
  price_wei       NUMERIC(78, 0) NOT NULL,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_foundation_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_foundation_fills_collection_idx
  ON plank_foundation_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_foundation_fills_block_idx
  ON plank_foundation_fills (chain_slug, block_number DESC);

-- Same shape/reasoning as plank_looksrare_fill_cursor.
CREATE TABLE IF NOT EXISTS plank_foundation_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
