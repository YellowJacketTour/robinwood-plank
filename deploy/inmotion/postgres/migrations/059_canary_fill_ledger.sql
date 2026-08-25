-- Bounded Blast-Radius Canary (BBRC) fill ledger -- see
-- docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
-- Issue 1 for the design this implements, and
-- lib/market/multichain/trading/canary-limits.ts for the enforcement code
-- that reads and writes this table.
--
-- SCOPE (read this before assuming this table protects anything today):
-- this migration and canary-limits.ts are INFRASTRUCTURE ONLY. As of this
-- migration, nothing in the live request path inserts into this table or
-- calls checkAndRecordCanaryLimit -- foreign-fulfill.ts, native-fulfill.ts,
-- and foreign-offer.ts are unmodified. Creating this table does not change
-- what any real trade can do. Wiring it into a live fund-moving path is a
-- separate, not-yet-authorized decision (see canary-limits.ts header).
--
-- ONE ROW PER RECORDED CANARY FILL
-- ---------------------------------
-- Every accepted canary-bounded foreign-chain trade (once/if this is wired
-- up) writes exactly one row here at accept-time. There is no separate
-- "bucket" table: per-wallet/24h, global/24h, and per-venue/24h caps are all
-- rolling-window aggregates computed with SUM(usd_notional) WHERE
-- created_at > NOW() - INTERVAL '24 hours' at check time (see
-- canary-limits.ts), the same style already used for chain_events-derived
-- stats elsewhere in this codebase (lib/market/chain-events.ts). This keeps
-- the schema append-only and trivially auditable -- the ledger itself is
-- the evidence -- at the cost of a full-table-scan-shaped query, which is
-- fine at canary volume (the whole point of the caps is that volume stays
-- tiny) and is covered by the indexes below regardless.
--
-- USD NOTIONAL, NOT NATIVE-ASSET AMOUNT
-- ---------------------------------------
-- The caps in the research doc ($25-50/trade, $100-200/wallet/day, etc.) are
-- USD figures so they mean the same thing across BTC, SOL, and any future
-- foreign chain. usd_notional is therefore the USD value AT THE TIME THE
-- TRADE WAS RECORDED, computed by the caller (canary-limits.ts takes it as
-- an input, it does not price anything itself) -- this table does not
-- re-derive or re-price historical rows, so a later price move never
-- retroactively changes whether a past trade counted against a cap.
--
-- WALLET ADDRESS IS CROSS-CHAIN AND CASE-SENSITIVE ON PURPOSE
-- --------------------------------------------------------------
-- wallet is stored exactly as the caller passes it (no lower()/checksum
-- normalization here) because canary wallets can be Bitcoin, Solana, or EVM
-- addresses with different native casing rules -- normalization, if needed,
-- is the caller's job (canary-limits.ts), not this table's.
--
-- Additive only; a build that has never heard of this table never queries
-- it, and no existing table or column is touched.
CREATE TABLE IF NOT EXISTS canary_fill_ledger (
  id BIGSERIAL PRIMARY KEY,

  -- Cross-chain wallet address exactly as supplied by the caller (see note
  -- above on casing). Never assumed to be a single chain's address format.
  wallet TEXT NOT NULL,

  -- Marketplace/venue this fill went through, e.g. 'magiceden', 'tensor',
  -- 'unisat'. Free text, not an enum: matches this codebase's existing
  -- venue-registry.ts convention of string venue identifiers rather than a
  -- Postgres enum that would need a migration to extend.
  venue TEXT NOT NULL,

  -- Chain slug, e.g. 'bitcoin', 'solana'. Same free-text convention as
  -- venue, matching foreign-chain-registry.ts chain slugs.
  chain TEXT NOT NULL,

  -- USD value of this fill at record time -- see note above. NUMERIC (not
  -- float) for exact accumulation across many small canary-sized fills.
  usd_notional NUMERIC(18, 2) NOT NULL CHECK (usd_notional > 0),

  -- Opaque reference to the underlying transaction/order (tx hash, PSBT id,
  -- signature, etc.) purely for audit trail -- never parsed or relied on for
  -- cap enforcement, which is usd_notional-only.
  tx_ref TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every cap query filters "this wallet, last 24h" or "this venue, last 24h";
-- the global cap filters "everything, last 24h" and can use created_at alone.
-- These two indexes cover both shapes without needing a third.
CREATE INDEX IF NOT EXISTS canary_fill_ledger_wallet_created_at_idx
  ON canary_fill_ledger (wallet, created_at);

CREATE INDEX IF NOT EXISTS canary_fill_ledger_venue_chain_created_at_idx
  ON canary_fill_ledger (venue, chain, created_at);

CREATE INDEX IF NOT EXISTS canary_fill_ledger_created_at_idx
  ON canary_fill_ledger (created_at);
