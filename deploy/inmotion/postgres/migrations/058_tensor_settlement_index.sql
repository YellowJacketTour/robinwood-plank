-- Self-hosted, on-chain Tensor SETTLEMENT scanner -- the Solana analogue of
-- 023_seaport_fill_index.sql / 048-055's own EVM fill indexes, applied for
-- the first time in this codebase to a Solana program (lib/market/
-- multichain/discovery/tensor-settlement-scan.ts).
--
-- WHY THIS EXISTS, AND WHAT IT IS NOT
-- -------------------------------------------------------------------
-- Tensor's off-chain order-book/stats API is confirmed key-gated with no
-- free tier (see venue-registry.ts's "tensor-solana" entry, settled
-- 2026-08-24). Tensor's SETTLED TRADES are, however, real public on-chain
-- events: every buy/takeBid instruction against Tensor's real, live
-- Tensor Marketplace program (TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp --
-- confirmed as the real value of TENSOR_MARKETPLACE_PROGRAM_ADDRESS exported
-- by the installed @tensor-foundation/marketplace package, and confirmed
-- LIVE via a real getSignaturesForAddress/getTransaction call against
-- api.mainnet-beta.solana.com on 2026-08-24, returning real, current-block
-- Bid/Edit/ListCore/DelistCore/TcompNoop activity) is public Solana chain
-- state, decodable with the same package's own generated instruction
-- discriminators/account layouts -- no Tensor-hosted API required.
--
-- This is READ-ONLY SETTLEMENT/ACTIVITY DATA, NOT THE LIVE ORDER BOOK.
-- It captures completed buy-a-listing (buyLegacy/buyCore/buyT22/buyWns/
-- buyCompressed and their *Spl currency variants) and complete-a-bid
-- (takeBidLegacy/takeBidCore/takeBidT22/takeBidWns/takeBid*Compressed*)
-- instructions only. It never sees open listings or open bids that have
-- not yet settled -- those remain gated behind Tensor's own API, exactly
-- as venue-registry.ts's tensor-solana entry now documents
-- (capabilities: ["sales"] only, never "listings"/"bids").
--
-- SCHEMA SHAPE ADAPTED FOR SOLANA FROM THE EVM FILL TABLES
-- -------------------------------------------------------------------
-- Same idempotent-upsert-by-natural-key shape as plank_x2y2_fills etc.,
-- with Solana's own primitives substituted throughout: base58 signatures
-- instead of 0x tx hashes, base58 pubkeys instead of 0x addresses, lamports
-- instead of wei, and slot instead of block number (Solana has no block
-- number; slot is the real, monotonic equivalent). A signature can contain
-- more than one Tensor settlement instruction in the same transaction (a
-- real, observed shape -- e.g. batched compressed-NFT buys), so the natural
-- key is (signature, instruction_index), not (signature) alone.
--
-- HONEST PRICE LIMITATION, STATED NOT HIDDEN
-- -------------------------------------------------------------------
-- Tensor's real instruction data (`maxAmount` on buy*, the analogous bid
-- amount on takeBid*) is a CEILING the buyer authorized, not necessarily
-- the exact cleared price (Tensor's AMM/pool pricing can clear below a
-- buyer's max). price_lamports here is instead the real, verified NET
-- LAMPORT DELTA on the seller-side account (`owner` for buy*, `seller` for
-- takeBid*) between the transaction's own preBalances/postBalances --  a
-- real, on-chain-observed settlement amount, not a decoded intent field --
-- see tensor-settlement-scan.ts's own header for the exact derivation and
-- its own honest boundary (SPL-currency variants, where the seller is paid
-- in an SPL token rather than native SOL, are out of scope for this first
-- pass and are not written here).
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS plank_tensor_fills (
  id                  BIGSERIAL PRIMARY KEY,

  chain_slug          TEXT NOT NULL DEFAULT 'solana-mainnet',
  signature           TEXT NOT NULL,
  instruction_index   INTEGER NOT NULL,
  slot                BIGINT NOT NULL,
  block_time          TIMESTAMPTZ,

  -- Tensor instruction name as decoded from its own real, installed-package
  -- discriminator bytes (e.g. "buyLegacy", "takeBidCore") -- never guessed.
  instruction_name    TEXT NOT NULL,
  settlement_kind      TEXT NOT NULL, -- 'buy_listing' | 'take_bid'
  asset_standard      TEXT NOT NULL, -- 'legacy' | 'core' | 't22' | 'wns' | 'compressed'

  mint                TEXT,          -- base58 mint/asset pubkey; NULL only for a compressed-asset variant this pass does not decode a stable id for
  seller              TEXT,          -- base58 pubkey ('owner' for buy*, 'seller' for takeBid*)
  buyer               TEXT,          -- base58 pubkey

  -- See header: real net lamport delta on the seller-side account, native
  -- SOL only. NULL for an SPL-currency variant (out of scope this pass).
  price_lamports      NUMERIC(38, 0),

  indexed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT plank_tensor_fills_unique UNIQUE (chain_slug, signature, instruction_index)
);

CREATE INDEX IF NOT EXISTS plank_tensor_fills_mint_idx
  ON plank_tensor_fills (chain_slug, mint, slot DESC);

CREATE INDEX IF NOT EXISTS plank_tensor_fills_slot_idx
  ON plank_tensor_fills (chain_slug, slot DESC);

-- Forward-only signature cursor, same shape as plank_seaport_fill_cursor /
-- plank_x2y2_fill_cursor -- one row per named lane (this scanner has a
-- single live-forward lane today; the key is still namespaced the same way
-- those tables are in case a genesis-backfill lane is added later).
CREATE TABLE IF NOT EXISTS plank_tensor_fill_cursor (
  cursor_key          TEXT PRIMARY KEY,
  -- Solana's real resumable unit for getSignaturesForAddress is the
  -- signature itself (`before`/`until` params), not a numeric height --
  -- unlike the EVM fill cursors' last_indexed_block.
  last_signature       TEXT,
  last_slot             BIGINT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
