-- Season 2: King of the Hill for Largest Single $PLANK Buy.
--
-- Reuses the EXACT same rule engine as the NFT largest-sale KOTH
-- (lib/market/king-of-the-hill-rules.ts, migration 009) -- that module is
-- deliberately asset-agnostic (a KothSale is just {txHash, tokenId, wallet,
-- priceWei}, tokenId already nullable), so this is a second, independent
-- singleton round rather than a schema change to the existing one. Keeping
-- them fully separate means the live NFT round (if any) and this PLANK round
-- can run concurrently without any shared-state risk.
--
-- "priceWei" here holds the real ETH (wei) actually paid for the buy, NOT
-- the raw PLANK amount received -- see docs/marketplank/GROK-FINDINGS-
-- plank-koth-fraud-detection-2026-08-25.md section 1: raw token amount is
-- the easy side to spoof in a thin/manipulated pool, real ETH spent is the
-- hard side (requires real capital to leave the buyer's balance and not
-- return in the same transaction). leading_plank_amount/winner_plank_amount
-- are stored purely for display -- they are never the ranking metric.
--
-- SINGLETON ROW, PERMANENT FINALIZATION, SEEDING -- see migration 009's own
-- header for the full reasoning; identical discipline applies here.
CREATE TABLE IF NOT EXISTS plank_koth (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  deadline TIMESTAMPTZ NOT NULL,

  -- Ranking metric: real ETH (wei) paid, confirmed to L1 finality (see the
  -- fraud-detection doc's section 5 -- Robinhood Chain's own documented
  -- ~13-minute soft->hard finality window) before it is ever written here.
  leading_tx_hash TEXT,
  leading_wallet TEXT,
  leading_eth_paid_wei NUMERIC(78, 0),
  leading_plank_amount NUMERIC(78, 0),
  leading_usd_value_at_buy NUMERIC(20, 2),
  leading_block_number BIGINT,

  winner_finalized_at TIMESTAMPTZ,
  winner_wallet TEXT,
  winner_tx_hash TEXT,
  winner_eth_paid_wei NUMERIC(78, 0),
  winner_plank_amount NUMERIC(78, 0),
  winner_usd_value_at_buy NUMERIC(20, 2),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 08:08 CDT 2026-08-26 (Central Daylight Time, UTC-5 in August) == 13:08 UTC.
-- 31 days later == 2026-09-26T13:08:00Z. Seeded once; the live extension
-- rule (applyCandidateSale) is the only thing allowed to move it after this.
INSERT INTO plank_koth (id, deadline)
VALUES (1, '2026-09-26T13:08:00Z')
ON CONFLICT (id) DO NOTHING;

-- "Tower of top buys" -- the full live-ranked leaderboard the UI shows
-- falling into place below the current leader, distinct from the singleton
-- state above (which only tracks the single leading/winning candidate).
-- Every CONFIRMED (post fraud-gate, post-finality) buy gets a permanent row
-- here regardless of whether it ever became the leader, so the UI can show
-- "top N buys" even before/after the record-holder changes.
CREATE TABLE IF NOT EXISTS plank_koth_leaderboard (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  wallet TEXT NOT NULL,
  eth_paid_wei NUMERIC(78, 0) NOT NULL,
  plank_amount NUMERIC(78, 0) NOT NULL,
  usd_value_at_buy NUMERIC(20, 2),
  block_number BIGINT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plank_koth_leaderboard_rank_idx
  ON plank_koth_leaderboard (eth_paid_wei DESC, block_number ASC);

-- Manual-review queue for anything the fraud pipeline flags rather than
-- outright passes or rejects (see the fraud-detection doc's synthesized
-- pipeline, stage 3e: "MANUAL REVIEW QUEUE... nothing auto-promotes out of
-- this queue"). A human resolves each row; nothing here ever silently
-- becomes a leaderboard/leader entry on its own.
CREATE TABLE IF NOT EXISTS plank_koth_review_queue (
  id BIGSERIAL PRIMARY KEY,
  tx_hash TEXT NOT NULL UNIQUE,
  wallet TEXT,
  eth_paid_wei NUMERIC(78, 0),
  plank_amount NUMERIC(78, 0),
  block_number BIGINT,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS plank_koth_review_queue_pending_idx
  ON plank_koth_review_queue (created_at) WHERE status = 'pending';
