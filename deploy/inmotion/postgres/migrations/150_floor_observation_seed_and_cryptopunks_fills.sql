-- Two things in one migration, because every migration on production costs
-- a pre-migration backup of a 36 GB database (1h42m measured 2026-09-14).
--
-- PART 1: seed one floor observation per stored floor.
-- -----------------------------------------------------
-- plank_collection_floor_observations was written by three writers only
-- (OpenSea stream, CryptoPunks, the home collection). writeSnapshot -- the
-- writer behind every adapter floor -- recorded nothing, so the 24h change
-- could never form for most of the catalog and every hub row said
-- "collecting baseline". The code now records an observation on every floor
-- write. This seeds the history with what is already known: each snapshot's
-- current floor, at the time it was observed (floor_observed_at, else
-- synced_at), so the whole catalog has its first endpoint the moment this
-- lands and a 24h pair one day later -- instead of starting from nothing.
--
-- Only floors whose currency and venue are known are seeded: an observation
-- without units or provenance is a number nobody can falsify. previous_floor
-- _price_wei is NOT seeded: it carries no timestamp, and inventing one would
-- be fabricating an endpoint.
--
-- Idempotent: the (collection_id, marketplace, observation_bucket) unique
-- key plus DO NOTHING means a re-run inserts nothing new.

INSERT INTO plank_collection_floor_observations
  (collection_id, price_atomic, currency, marketplace, listed_count, source, observed_at, observation_bucket)
SELECT s.collection_id,
       s.floor_price_wei::numeric,
       s.floor_price_currency,
       s.floor_price_marketplace,
       s.listed_count,
       'seed-150-snapshot',
       COALESCE(s.floor_observed_at, s.synced_at),
       date_trunc('minute', COALESCE(s.floor_observed_at, s.synced_at))
  FROM plank_multichain_snapshots s
 WHERE s.floor_price_wei IS NOT NULL
   AND s.floor_price_wei > 0
   AND s.floor_price_currency IS NOT NULL
   AND s.floor_price_marketplace IS NOT NULL
   AND COALESCE(s.floor_observed_at, s.synced_at) IS NOT NULL
ON CONFLICT (collection_id, marketplace, observation_bucket) DO NOTHING;

-- PART 2: the CryptoPunks market fill ledger.
-- -------------------------------------------
-- The activity feed unions eleven venue ledgers and none is the CryptoPunks
-- market (0xb47e3cd837dDF8e4c57F05d70Ab865de6e193BBB), so Punks volume and
-- sales read "not yet" and can never fill. The contract predates ERC-721:
-- its sale event is PunkBought(uint indexed punkIndex, uint value, address
-- indexed fromAddress, address indexed toAddress). One quirk, confirmed in
-- the contract source: acceptBidForPunk clears the bid storage BEFORE
-- emitting PunkBought, so that path emits value = 0 and toAddress = 0x0; the
-- real price and buyer are the latest PunkBidEntered for that index, and the
-- buyer is also the same transaction's Transfer `to`. The indexer records
-- which path produced each row (sale_kind) and never writes a 0 price as a
-- sale.
--
-- Shape mirrors the other fill ledgers so the feed's union branch and its
-- sort-covering index (the exact per-branch key, see 148) are the same
-- pattern: (chain_slug, nft_contract, block_timestamp DESC NULLS LAST,
-- block_number DESC, log_index DESC).

CREATE TABLE IF NOT EXISTS plank_cryptopunks_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  nft_contract    TEXT NOT NULL,          -- the market contract, lowercased; Punks are their own collection
  token_id        NUMERIC(78, 0) NOT NULL, -- punkIndex
  seller          TEXT NOT NULL,          -- fromAddress, lowercased
  buyer           TEXT NOT NULL,          -- toAddress, or the bid's bidder on the acceptBid path, lowercased
  price_wei       NUMERIC(78, 0) NOT NULL CHECK (price_wei > 0),
  sale_kind       TEXT NOT NULL,          -- 'buy' (PunkBought carried the price) | 'accept-bid' (price from PunkBidEntered)
  bid_log_index   INTEGER,                -- the PunkBidEntered the price came from, accept-bid only
  bid_tx_hash     TEXT,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_cryptopunks_fills_unique UNIQUE (chain_slug, tx_hash, log_index),
  CONSTRAINT plank_cryptopunks_fills_kind_check CHECK (sale_kind IN ('buy', 'accept-bid'))
);

CREATE INDEX IF NOT EXISTS plank_cryptopunks_fills_feed_idx
  ON plank_cryptopunks_fills (chain_slug, nft_contract, block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS plank_cryptopunks_fills_block_idx
  ON plank_cryptopunks_fills (chain_slug, nft_contract, block_number DESC);
CREATE INDEX IF NOT EXISTS plank_cryptopunks_fills_token_idx
  ON plank_cryptopunks_fills (chain_slug, nft_contract, token_id, block_number DESC);
