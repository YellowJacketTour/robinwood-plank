-- Marketplank-native Bitcoin Ordinals listings -- own PSBT engine, no
-- UniSat order book involved. Built 2026-08-19.
--
-- WHY NATIVE, NOT ANOTHER FIELD ON UniSat's FLOW
-- ------------------------------------------------------------------
-- unisat-ordinals-trade.ts already routes through UniSat's own Auction
-- House PSBT flow, and that stays -- it's the discovery/display source
-- for third-party listings. But UniSat's documented create_bid/
-- create_bid_prepare endpoints expose no affiliate/referral fee field the
-- way Magic Eden's buyerReferral does (checked their real dev docs, not
-- assumed absent), so trades through that flow earn Marketplank nothing.
-- This table is a SEPARATE, additive listing surface for sellers who list
-- directly with Marketplank -- same shape as the foreign-EVM native
-- listing feature (MARKETPLANK_NATIVE_LISTING_FEE_BPS), just for Bitcoin.
--
-- THE PSBT CONSTRUCTION PATTERN (SIGHASH_SINGLE | ANYONECANPAY, dummy
-- UTXO) IS OpenOrdex's PROVEN PROTOCOL, NOT INVENTED HERE
-- ------------------------------------------------------------------
-- Verified live 2026-08-19 by reading OpenOrdex's own real source
-- (github.com/orenyomtov/openordex, js/app.js): the seller signs ONE input
-- (their inscription UTXO) with SIGHASH_SINGLE|ANYONECANPAY committing it
-- to ONE output (their payment address) -- a signature that stays valid no
-- matter what the fulfiller appends around it. The fulfiller then prepends
-- a small "dummy" UTXO as input 0 and sizes output 0 (the buyer's
-- receiving address) to dummy_value + inscription_utxo_value, which
-- guarantees the inscribed satoshi -- wherever it sits inside the seller's
-- UTXO -- is consumed entirely into that one output, never split into
-- change or a fee output. See native-bitcoin-listing.ts for the actual
-- implementation, which reproduces this exact pattern.
--
-- ONLY THE SELLER'S HALF IS STORED. The fulfillment PSBT (buyer's dummy +
-- payment UTXOs, our fee output, buyer's change) is built fresh per
-- purchase attempt from live UTXO data -- storing it would go stale the
-- instant any input UTXO is spent elsewhere.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS market_native_bitcoin_listings (
  id                  TEXT PRIMARY KEY,

  seller_address      TEXT NOT NULL,
  inscription_id      TEXT NOT NULL,

  -- The exact UTXO the seller's inscription lives on at listing time.
  -- Re-verified live against UniSat's indexer immediately before building
  -- any fulfillment PSBT (see native-bitcoin-listing.ts) -- an inscription
  -- can move (re-inscribe, transfer) after listing, and a stale utxo
  -- reference must never be trusted as still-valid.
  utxo_txid           TEXT NOT NULL,
  utxo_vout           INTEGER NOT NULL,
  utxo_value_sats     BIGINT NOT NULL,

  price_sats          BIGINT NOT NULL CHECK (price_sats > 0),

  -- Base64 PSBT, ONE signed input (index 0, the inscription UTXO),
  -- SIGHASH_SINGLE | ANYONECANPAY. Never re-signed or mutated after
  -- listing -- a fulfillment PSBT is built by copying this input/output
  -- pair into a new transaction, never by editing this row's own PSBT.
  seller_psbt_base64  TEXT NOT NULL,

  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sold_at             TIMESTAMPTZ,
  sold_txid           TEXT,

  -- One active listing per UTXO -- prevents double-listing the same
  -- inscription while a prior listing is still live (the DB-level guard;
  -- the real on-chain guard is that a spent UTXO simply fails to build a
  -- valid fulfillment PSBT at all).
  UNIQUE (utxo_txid, utxo_vout, status)
);

CREATE INDEX IF NOT EXISTS market_native_bitcoin_listings_status_idx
  ON market_native_bitcoin_listings (status);
CREATE INDEX IF NOT EXISTS market_native_bitcoin_listings_seller_idx
  ON market_native_bitcoin_listings (seller_address);
CREATE INDEX IF NOT EXISTS market_native_bitcoin_listings_inscription_idx
  ON market_native_bitcoin_listings (inscription_id);
