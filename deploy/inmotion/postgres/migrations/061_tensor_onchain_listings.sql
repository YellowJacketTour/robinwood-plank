-- Self-hosted, on-chain Tensor ACTIVE-LISTING scanner -- the sibling of
-- 058_tensor_settlement_index.sql, this time indexing Tensor's *open*
-- listings (lib/market/multichain/discovery/tensor-listing-scan.ts) rather
-- than settled trades.
--
-- WHY THIS EXISTS, AND WHAT IT IS NOT
-- -------------------------------------------------------------------
-- Tensor's off-chain order-book/stats API remains confirmed key-gated with
-- no free tier (see venue-registry.ts's "tensor-solana" entry, settled
-- 2026-08-24 -- that finding is unchanged and untouched by this migration).
-- Tensor's ACTIVE LISTINGS, however, live in real, public, ordinary Solana
-- accounts of type `ListState` (an Anchor-style account owned by the real,
-- live Tensor Marketplace program TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp),
-- readable via a plain `getProgramAccounts` call with a `memcmp` filter on
-- that account type's own real 8-byte discriminator -- both the account
-- type and its discriminator bytes are read directly from the installed
-- @tensor-foundation/marketplace package
-- (dist/types/generated/accounts/listState.d.ts /
-- dist/src/index.js's `LIST_STATE_DISCRIMINATOR`), not guessed. A real,
-- live `getProgramAccounts` call against api.mainnet-beta.solana.com made
-- during this task (2026-08-25) returned 115,370 real `ListState` accounts
-- on the first pass, each of which decoded cleanly via that same package's
-- own `getListStateDecoder()` into real `owner`/`assetId`/`amount`/`expiry`
-- fields -- see tensor-listing-scan.ts's own header for the exact sampled
-- values quoted in the task report.
--
-- This is a REAL, DIRECT ON-CHAIN ACCOUNT SCAN, NOT TENSOR'S OWN
-- RANKED/AGGREGATED OFF-CHAIN BOOK. Completeness here is bounded by
-- whatever this app's chosen public RPC's own getProgramAccounts index
-- currently returns, not Tensor's own internal index -- see
-- venue-registry.ts's updated tensor-solana entry for the honest
-- distinction between the two.
--
-- SCHEMA SHAPE
-- -------------------------------------------------------------------
-- One row per (chain_slug, listing_account) -- the ListState account's own
-- address IS the natural key for a listing (Tensor never reuses a
-- ListState PDA for two different concurrently-open listings). A full
-- getProgramAccounts pass is a point-in-time snapshot, not an incremental
-- diff, so this scanner UPSERTS by listing_account every run and a
-- separate reaper (see tensor-listing-scan.ts) marks a row's `is_active`
-- false once a previously-seen listing_account stops appearing in a fresh
-- full pass (delisted, sold, or expired).
--
-- Additive only; a build that has never heard of this table never queries it.

CREATE TABLE IF NOT EXISTS tensor_onchain_listings (
  id                  BIGSERIAL PRIMARY KEY,

  chain_slug          TEXT NOT NULL DEFAULT 'solana-mainnet',

  -- The ListState account's own address -- stable, unique per open listing.
  listing_account     TEXT NOT NULL,

  mint                TEXT NOT NULL,          -- ListState.assetId (base58 mint/asset pubkey)
  owner_account       TEXT NOT NULL,          -- ListState.owner (base58 pubkey of the lister/seller)
  price_lamports      NUMERIC(38, 0) NOT NULL, -- ListState.amount, real lamport ask price
  currency            TEXT,                    -- ListState.currency, base58 SPL mint if Some, NULL for native SOL
  expiry              TIMESTAMPTZ,             -- ListState.expiry (unix seconds), NULL if unset/zero

  slot                BIGINT NOT NULL,         -- chain slot as of the getProgramAccounts pass that saw this row
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,

  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- last full pass that re-confirmed this row

  CONSTRAINT tensor_onchain_listings_unique UNIQUE (chain_slug, listing_account)
);

CREATE INDEX IF NOT EXISTS tensor_onchain_listings_mint_idx
  ON tensor_onchain_listings (chain_slug, mint) WHERE is_active;

CREATE INDEX IF NOT EXISTS tensor_onchain_listings_active_idx
  ON tensor_onchain_listings (chain_slug, is_active, fetched_at DESC);

-- One row per scan lane, mirroring plank_tensor_fill_cursor's shape --
-- records only bookkeeping (last full-pass timestamp/slot), since
-- getProgramAccounts itself has no incremental cursor to persist.
CREATE TABLE IF NOT EXISTS tensor_onchain_listing_scan_state (
  scan_key            TEXT PRIMARY KEY,
  last_scanned_at     TIMESTAMPTZ,
  last_slot           BIGINT,
  last_account_count  INTEGER,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
