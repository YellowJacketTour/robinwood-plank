-- Magic Eden M2 seller trade states read straight from the chain
-- (2026-09-07, DESIGN-HUNTER "next drivers" #2). Same shape as
-- tensor_onchain_listings (061) so the Solana hunter unions both venues.
-- Online-only: a new table, no rewrite of an existing one.
CREATE TABLE IF NOT EXISTS m2_onchain_listings (
  id                  BIGSERIAL PRIMARY KEY,
  chain_slug          TEXT NOT NULL DEFAULT 'solana-mainnet',
  listing_account     TEXT NOT NULL,           -- SellerTradeState PDA
  mint                TEXT NOT NULL,           -- tokenMint
  owner_account       TEXT NOT NULL,           -- seller wallet
  auction_house       TEXT NOT NULL,
  price_lamports      NUMERIC(38, 0) NOT NULL,
  expiry              TIMESTAMPTZ,             -- NULL when M2's -1 "no expiry"
  slot                BIGINT NOT NULL,
  shard               SMALLINT NOT NULL,          -- first byte of tokenMint: the sweep's unit of reaping
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT m2_onchain_listings_unique UNIQUE (chain_slug, listing_account)
);
CREATE INDEX IF NOT EXISTS m2_onchain_listings_mint_idx ON m2_onchain_listings (chain_slug, mint) WHERE is_active;
CREATE INDEX IF NOT EXISTS m2_onchain_listings_shard_idx ON m2_onchain_listings (chain_slug, shard) WHERE is_active;
