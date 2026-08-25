-- Self-hosted, on-chain LooksRare v1 TakerAsk/TakerBid fill index -- same
-- rationale as 023_seaport_fill_index.sql (Reservoir and SimpleHash both
-- shut down; on-chain data is this app's own first-party replacement),
-- applied to the second real historic marketplace this app had zero
-- indexing for despite real 2022+ sales volume.
--
-- SEPARATE TABLE FROM plank_seaport_fills, DELIBERATELY
-- -------------------------------------------------------------------
-- LooksRareExchange emits two distinct events (TakerAsk / TakerBid) with a
-- different shape than Seaport's single OrderFulfilled (no bundle/multi-item
-- support in v1 -- exactly one NFT, one currency leg per fill), and the
-- table name plank_seaport_fills is explicitly Seaport-scoped in its own
-- migration header. Reusing it for a different protocol's fills would be a
-- false claim about what that table means. The lossless per-leg tables
-- (plank_market_event_assets / plank_market_event_payments, migration 046)
-- ARE venue-generic and are reused as-is via venue_id = 'looksrare'.
--
-- ADDRESS / EVENT SOURCE (cited, not guessed)
-- -------------------------------------------------------------------
-- LooksRareExchange v1 mainnet address 0x59728544b08ab483533076417fbbb2fd0b17ce3a
-- is LooksRare's own official docs (https://docs.looksrare.org/developers/
-- deployed-contract-addresses), cross-confirmed by Etherscan's own listing
-- title "LooksRare: Exchange" at the same address. TakerAsk/TakerBid event
-- signatures are copied verbatim from LooksRare's own published source,
-- https://github.com/LooksRare/contracts-exchange-v1/blob/master/contracts/
-- LooksRareExchange.sol. See lib/market/multichain/looksrare-fill-
-- indexer.ts's own header for the full citation and scope notes (v1,
-- eth-mainnet only -- v2's multi-chain TakerBid/TakerAsk shape was not
-- independently re-verified this pass and is explicitly out of scope).
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_looksrare_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  order_hash      TEXT NOT NULL,
  order_nonce     NUMERIC(78, 0),
  event_name      TEXT NOT NULL CHECK (event_name IN ('TakerAsk','TakerBid')),

  seller          TEXT NOT NULL,
  buyer           TEXT NOT NULL,
  strategy        TEXT,

  nft_contract    TEXT NOT NULL,
  token_id        NUMERIC(78, 0) NOT NULL,
  amount          NUMERIC(78, 0),

  -- NULL currency_token means native ETH-denominated (LooksRare v1's own
  -- matchAskWithTakerBidUsingETHAndWETH path); non-null is the ERC-20
  -- (almost always WETH) address actually passed as `currency`.
  currency_token  TEXT,
  price_wei       NUMERIC(78, 0) NOT NULL,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_looksrare_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_looksrare_fills_collection_idx
  ON plank_looksrare_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_looksrare_fills_block_idx
  ON plank_looksrare_fills (chain_slug, block_number DESC);

-- Same shape/reasoning as plank_seaport_fill_cursor: a separate cursor table
-- because this watches a different address/topic pair than any existing
-- scan and must never share key space with an unrelated cursor.
CREATE TABLE IF NOT EXISTS plank_looksrare_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
