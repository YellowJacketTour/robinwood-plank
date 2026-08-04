-- Plank Checks — the vanity points/referral ledger. See
-- docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md §1 for the full design.
--
-- Points have no redemption value today (vanity leaderboard only) and this
-- schema does not assume otherwise, but is built so a future conversion
-- (airdrop snapshot, allowlist priority, fee-discount tiers) is a read over
-- this same permanent ledger, never a migration of it.
--
-- Zero custody, zero new contract: wallet linking is the same stateless
-- signature scheme lib/admin-auth.ts already uses for admin actions,
-- generalized to any wallet (see lib/plank-checks.ts). The only money that
-- ever moves is the optional 0.01 ETH additional-wallet-link fee, sent to
-- the existing treasury address and verified by reading the real
-- transaction on-chain — never held or routed by this app.
--
-- Additive only, safe against the immediately previous release (a build
-- that has never heard of these tables simply never queries them).

CREATE TABLE IF NOT EXISTS plank_checks_profiles (
  profile_id   BIGSERIAL PRIMARY KEY,
  vanity_name  TEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- First 2 wallets per profile are free (link_tx_hash IS NULL). Every
-- additional wallet must carry a real, verified 0.01 ETH payment to the
-- treasury — enforced in application code (lib/plank-checks.ts), not by a
-- constraint here, since verifying "this tx really paid 0.01 ETH to the
-- treasury" requires a chain read the database itself cannot perform.
CREATE TABLE IF NOT EXISTS plank_checks_wallets (
  wallet_address  TEXT PRIMARY KEY,
  profile_id      BIGINT NOT NULL REFERENCES plank_checks_profiles(profile_id),
  linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  link_tx_hash    TEXT,
  link_fee_wei    TEXT NOT NULL DEFAULT '0'
);
CREATE INDEX IF NOT EXISTS plank_checks_wallets_profile_idx
  ON plank_checks_wallets (profile_id);

-- Permanent, append-only ledger. Never UPDATEd or DELETEd — a "season" is a
-- read-time filter on earned_at (see lib/plank-checks.ts), never a mutation
-- of this table, so raw history is never lost when seasons toggle on/off.
CREATE TABLE IF NOT EXISTS plank_checks_events (
  event_id        BIGSERIAL PRIMARY KEY,
  wallet_address  TEXT NOT NULL,
  category        TEXT NOT NULL,
  points          NUMERIC NOT NULL,
  source_tx_hash  TEXT,
  referred_wallet TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  earned_at       TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS plank_checks_events_wallet_idx
  ON plank_checks_events (wallet_address, earned_at);
CREATE INDEX IF NOT EXISTS plank_checks_events_earned_at_idx
  ON plank_checks_events (earned_at);
-- A source transaction should only ever be scored once per category — the
-- real backstop against double-crediting a re-processed cron pass.
CREATE UNIQUE INDEX IF NOT EXISTS plank_checks_events_dedupe_idx
  ON plank_checks_events (source_tx_hash, category, wallet_address)
  WHERE source_tx_hash IS NOT NULL;
