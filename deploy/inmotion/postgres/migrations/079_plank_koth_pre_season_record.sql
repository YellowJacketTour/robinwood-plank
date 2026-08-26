-- Real, audited pre-season reference: the single largest $PLANK buy ever
-- made BEFORE Season 2's own launch instant, found by walking the token's
-- full real transfer history (scripts/audit-plank-historical-record.ts)
-- using the exact same value-resolution/fraud-check primitives the live
-- Season 2 pipeline uses. Operator's own explicit ask: "as proof you know
-- your methods work you should have to audit all historical buys."
--
-- Singleton row, purely a display reference -- never fed into
-- king-of-the-hill-rules.ts (a pre-launch buy was never a real contest
-- entry; see plank-koth.ts's own PLANK_KOTH_LAUNCH_AT_MS gate). Shown as a
-- minor "previous record" line until the real competition begins, at
-- which point the live leaderboard supersedes it as the thing that
-- actually matters.
CREATE TABLE IF NOT EXISTS plank_koth_pre_season_record (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tx_hash TEXT NOT NULL,
  wallet TEXT NOT NULL,
  eth_paid_wei NUMERIC(78, 0) NOT NULL,
  plank_amount NUMERIC(78, 0) NOT NULL,
  usd_value_at_buy NUMERIC(20, 2),
  block_number BIGINT NOT NULL,
  audited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
