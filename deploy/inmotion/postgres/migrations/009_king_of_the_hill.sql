-- King of the Hill: the promoted, real-money mechanic — see the pinned tweet
-- ("when timer is within 2 hours, any new largest sale will extend a grace
-- period of 4 hours to place the new highest sale... once sustained king of
-- the hill is timed out, the winner will be awarded"). Before this migration
-- there was no server-side state for the round at all:
-- components/market/EventCountdown.tsx carried a hardcoded, client-only
-- `TARGET_ISO` constant with no persistence, no extension logic, and no
-- winner determination — the countdown was cosmetic only.
--
-- SINGLETON ROW
-- -------------
-- Exactly one round is live at a time, so this is a single-row table guarded
-- by `id = 1`. That keeps every read/write a plain keyed UPDATE (no ORDER BY
-- / LIMIT race to pick "the" row) and lets Postgres serialize concurrent
-- extension attempts with a normal row lock (see lib/market/king-of-the-hill.ts
-- SELECT ... FOR UPDATE).
--
-- FINALIZATION IS PERMANENT
-- --------------------------
-- `winner_finalized_at` is written exactly once. Every write path in
-- lib/market/king-of-the-hill.ts checks it first and no-ops if it is already
-- set — a later, larger sale arriving after finalization must never change
-- the recorded winner. There is no code path anywhere that clears it.
--
-- SEEDING
-- -------
-- The row is seeded with the deadline the tweet already publicly committed to
-- (the same instant that was hardcoded as EventCountdown's TARGET_ISO) so
-- shipping this migration does not silently reset a deadline users were
-- already told. `ON CONFLICT DO NOTHING` makes the seed idempotent and a
-- no-op on any redeploy.
--
-- COMPATIBILITY
-- -------------
-- Purely additive — a new table, nothing else touched. The immediately
-- previous release never queries it and is unaffected by its presence.

CREATE TABLE IF NOT EXISTS king_of_the_hill (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Real UTC instant the round currently closes at. Mutable only by the
  -- extension rule in lib/market/king-of-the-hill.ts, and only before
  -- finalization.
  deadline TIMESTAMPTZ NOT NULL,

  -- The current leading (record-highest) confirmed sale, whatever the ledger
  -- already tracks for one (plank_chain_events / migration 008). All null
  -- until the first qualifying sale is observed.
  leading_tx_hash TEXT,
  leading_token_id TEXT,
  leading_price_wei NUMERIC(78, 0),
  leading_wallet TEXT,

  -- Set exactly once, by the finalize step, and never overwritten or
  -- cleared afterward.
  winner_finalized_at TIMESTAMPTZ,
  winner_wallet TEXT,
  winner_tx_hash TEXT,
  winner_token_id TEXT,
  winner_price_wei NUMERIC(78, 0),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed the singleton row with the deadline already promised publicly.
-- 8/8/26 04:20 CDT == 2026-08-08T09:20:00Z, the exact instant that was
-- hardcoded as components/market/EventCountdown.tsx's TARGET_ISO.
INSERT INTO king_of_the_hill (id, deadline)
VALUES (1, '2026-08-08T09:20:00Z')
ON CONFLICT (id) DO NOTHING;
