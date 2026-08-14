-- Opaque referral codes, so an invite link stops publishing a wallet address.
--
-- WHY
-- ---
-- 010_referral_attribution.sql shipped invite links of the form
-- /trade?ref=0x<40 hex>. The link works, but sharing one — to Telegram, to X,
-- anywhere public — permanently ties a person's identity to a wallet anyone
-- can then read in full: holdings, trade history, NFTs. The people most
-- likely to share an invite widely are exactly the people with the most
-- on-chain to expose. This table gives every wallet a short opaque code to
-- share instead, resolved back to the address server-side at claim time.
--
-- RANDOM, NOT DERIVED
-- -------------------
-- The code is random, not a hash of the address. A plain hash would be
-- computable by anyone: with a list of known wallets — every $PLANK holder is
-- public chain data — an attacker hashes each one and matches it against a
-- shared code, recovering the address and defeating the entire point. A keyed
-- hash would fix that but adds a production secret to provision and rotate.
-- Random codes need neither, and are unguessable by construction.
--
-- NUMBERED 012
-- ------------
-- 011 is claimed by the MoonPay ramp on an open PR. Migrations are
-- append-only and applied in filename order, so two branches taking the same
-- number is a conflict at deploy time rather than review time.
--
-- Additive only; a build that has never heard of this table never queries it,
-- and 010's attribution rows are untouched and keep working.

CREATE TABLE IF NOT EXISTS plank_referral_codes (
  -- Uppercase alphanumeric, ambiguous characters excluded (see
  -- lib/referral-codes.ts) — these get read aloud and retyped from screens.
  code            TEXT PRIMARY KEY,

  -- Lowercased wallet the code resolves to. UNIQUE so a wallet has exactly
  -- one code: regenerating on each view would invalidate links already
  -- shared, which for a referral link is the whole value of the thing.
  wallet_address  TEXT NOT NULL UNIQUE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What is this wallet's code" — the panel's read on every render for a
-- connected wallet. The UNIQUE constraint above already indexes this; named
-- explicitly here so the intent survives a future schema change that relaxes
-- uniqueness for some reason.
CREATE INDEX IF NOT EXISTS plank_referral_codes_wallet_idx
  ON plank_referral_codes (wallet_address);
