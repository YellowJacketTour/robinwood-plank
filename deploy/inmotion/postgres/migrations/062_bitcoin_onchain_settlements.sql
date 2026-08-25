-- Settlement-First Universal Index (SFUI) for Bitcoin Ordinals -- the free,
-- keyless substitute for the dead Best in Slot API and for OKX/Gamma/
-- ORD.NET's still-gated ACTIVITY data specifically (never their live order
-- books -- see docs/marketplank/GROK-FINDINGS-free-remedies-2026-08-25.md,
-- "Cross-cutting free architecture" section A, and this migration's
-- companion scanner lib/market/multichain/discovery/bitcoin-settlement-scan.ts).
--
-- WHAT THIS TABLE IS
-- -------------------------------------------------------------------
-- mempool.space's real, free, public API (verified live 2026-08-24 -- see
-- the scanner file header for the exact endpoints and a real response) has
-- NO concept of "inscriptions": it is a plain Bitcoin transaction/UTXO
-- explorer. This app already knows which inscription id sits at which
-- Bitcoin address from its own UniSat inscription-indexer transfer scan
-- (plank_market_events rows with venue_id = 'wallet-transfer', written by
-- unisat-transfer-scan.ts) -- that scan already resolves the real txid,
-- previous holder ("seller"), and new holder ("buyer") address for every
-- observed inscription move, but it deliberately records NO price: a
-- transfer event alone cannot tell a sale from a gift.
--
-- This table is the missing price layer: for every such transfer, the
-- companion scanner independently re-fetches the SAME real txid from
-- mempool.space (free, keyless) and inspects its real vin/vout structure to
-- see whether the previously-known holder ("seller") also received a
-- payment output in that same transaction -- the standard Ordinals
-- marketplace PSBT settlement shape (inscription-bearing UTXO spent as one
-- input, payment to the seller as a separate output, same transaction).
--
-- HONEST LIMITATION, STATED NOT HIDDEN (see scanner file header for the
-- full derivation): this is a HEURISTIC, not a certainty. A plain gift or
-- an internal wallet consolidation can be misread as "no payment found"
-- (correctly labeled uncertain), and a coincidental payment to the same
-- address in the same transaction for an unrelated reason could in theory
-- be misread as a sale. There is no marketplace-signed receipt to check
-- against -- confidence_label exists specifically so this app never claims
-- more certainty than the raw chain data actually supports.
--
-- Additive only; nothing that has never heard of this table queries it.

CREATE TABLE IF NOT EXISTS bitcoin_onchain_settlements (
  id                  BIGSERIAL PRIMARY KEY,

  inscription_id      TEXT NOT NULL,
  txid                TEXT NOT NULL,

  -- NULL when a spend was observed but no plausible payment-to-seller
  -- output could be identified in the same transaction (confidence_label
  -- = 'spend_observed_uncertain' in that case -- see scanner header).
  price_sats          BIGINT,

  buyer_address       TEXT,
  seller_address      TEXT,

  block_height        BIGINT,
  block_time          TIMESTAMPTZ,

  -- 'high_confidence_marketplace_pattern' -- a clean single-seller-input,
  --   net-positive payment-to-seller pattern matched (see scanner header
  --   for the exact rule).
  -- 'spend_observed_uncertain' -- the known inscription-bearing UTXO was
  --   confirmed spent in this real transaction, but sale vs. transfer/gift
  --   could not be distinguished from the raw vin/vout data alone.
  confidence_label    TEXT NOT NULL CHECK (confidence_label IN (
                         'high_confidence_marketplace_pattern',
                         'spend_observed_uncertain'
                       )),

  -- Always 'onchain_settlement' -- never confused with a marketplace's own
  -- hosted API data (see venue-registry.ts's tensor-solana entry for the
  -- same labeling discipline applied to the Solana equivalent).
  source              TEXT NOT NULL DEFAULT 'onchain_settlement',

  -- Real mempool.space tx response (trimmed) this row was derived from --
  -- kept for audit/replay, never re-interpreted as a second source.
  raw_event           JSONB,

  indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bitcoin_onchain_settlements_unique UNIQUE (inscription_id, txid)
);

CREATE INDEX IF NOT EXISTS bitcoin_onchain_settlements_inscription_idx
  ON bitcoin_onchain_settlements (inscription_id, block_height DESC);

CREATE INDEX IF NOT EXISTS bitcoin_onchain_settlements_txid_idx
  ON bitcoin_onchain_settlements (txid);

CREATE INDEX IF NOT EXISTS bitcoin_onchain_settlements_block_idx
  ON bitcoin_onchain_settlements (block_height DESC);
