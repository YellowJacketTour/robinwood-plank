-- Self-hosted, on-chain BlurExchange OrdersMatched fill index -- same
-- rationale as 023_seaport_fill_index.sql / 048_looksrare_fill_index.sql /
-- 049_wyvern_fill_index.sql (on-chain data is this app's own first-party
-- replacement for the shut-down Reservoir/SimpleHash APIs), applied to the
-- third real historic marketplace this app had zero indexing for.
--
-- A PRIOR PASS DID NOT BUILD THIS -- WHY THIS PASS COULD
-- -------------------------------------------------------------------
-- The prior pass deferred Blur because Blur's real fill event also lives
-- behind a separate Blend pooled-bid/lending contract that normalizes
-- differently from a simple 1:1 fill. Real research this pass (2026-08-23)
-- confirmed BlurExchange itself DOES emit its own real, simple, single-fill
-- event -- OrdersMatched -- independent of Blend, covering direct
-- marketplace sell/buy-order matches (the bulk, "80% case" marketplace
-- volume). Blend's pooled-bid normalization is NOT built here and remains
-- explicitly deferred -- see blur-fill-indexer.ts's own header for the
-- precise reason (Blend uses a fundamentally different pooled-debt/loan
-- event shape, not a simple fill, and was not independently re-verified
-- against primary source this pass).
--
-- ADDRESS / EVENT SOURCE (cited, not guessed)
-- -------------------------------------------------------------------
-- BlurExchange proxy address 0x000000000000Ad05Ccc4F10045630fb830B95127
-- (eth-mainnet) -- independently re-confirmed 2026-08-23 via Sourcify's own
-- verified-contract API (https://sourcify.dev/server/v2/contract/1/
-- 0x000000000000Ad05Ccc4F10045630fb830B95127), which shows an "exact match"
-- verified ERC1967Proxy at this address (verifiedAt 2024-08-08), deployed at
-- block 15779579. Etherscan's UI labels the same address "Blur.io:
-- Marketplace 2". The OrdersMatched event signature and the Order/Fee
-- struct layouts are copied verbatim from Blur's own Code4rena-audited
-- source, https://github.com/code-423n4/2022-10-blur/blob/main/contracts/
-- BlurExchange.sol and .../contracts/lib/OrderStructs.sol -- the real,
-- published source Blur submitted for its own October 2022 audit, not a
-- log-snippet reconstruction. See blur-fill-indexer.ts's own header for the
-- full event/struct text and the honest Blend scope note.
--
-- SEPARATE TABLE, DELIBERATELY -- REUSES THE SHARED LOSSLESS LEG TABLES
-- -------------------------------------------------------------------
-- Same reasoning as 048_looksrare_fill_index.sql: OrdersMatched has its own
-- distinct shape (two full Order structs, arbitrary per-order fee arrays),
-- so it gets its own summary table, plank_blur_fills, while the lossless
-- per-leg tables (plank_market_event_assets / plank_market_event_payments,
-- migration 046) are venue-generic and reused as-is via venue_id = 'blur'.
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_blur_fills (
  id              BIGSERIAL PRIMARY KEY,

  chain_slug      TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp TIMESTAMPTZ,

  sell_hash       TEXT NOT NULL,
  buy_hash        TEXT NOT NULL,

  seller          TEXT NOT NULL,
  buyer           TEXT NOT NULL,

  nft_contract    TEXT NOT NULL,
  token_id        NUMERIC(78, 0) NOT NULL,
  amount          NUMERIC(78, 0),

  -- NULL currency_token means native ETH (BlurExchange's own paymentToken
  -- convention -- the zero address -- same normalization plank_looksrare_
  -- fills and plank_seaport_fills already use).
  currency_token  TEXT,
  price_wei       NUMERIC(78, 0) NOT NULL,

  indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_blur_fills_unique UNIQUE (chain_slug, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS plank_blur_fills_collection_idx
  ON plank_blur_fills (chain_slug, nft_contract, block_number DESC);

CREATE INDEX IF NOT EXISTS plank_blur_fills_block_idx
  ON plank_blur_fills (chain_slug, block_number DESC);

-- Same shape/reasoning as plank_looksrare_fill_cursor / plank_wyvern_fill_
-- cursor: a separate cursor table because this watches a different
-- address/topic pair than any existing scan and must never share key space
-- with an unrelated cursor.
CREATE TABLE IF NOT EXISTS plank_blur_fill_cursor (
  cursor_key         TEXT PRIMARY KEY,
  last_indexed_block BIGINT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
