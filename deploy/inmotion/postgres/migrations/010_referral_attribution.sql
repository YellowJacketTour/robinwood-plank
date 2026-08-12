-- Referral attribution: who referred whom, real and permanent. Before this
-- migration there was no referral system anywhere in this app at all
-- (confirmed: zero hits for referralCode/referred_by/refCode across the
-- codebase) -- this is the foundation any future referral rebate/payout
-- mechanism would build on, not a payout mechanism itself. See
-- lib/referral-server.ts's own header for why the payout side is
-- deliberately NOT included yet.
--
-- IMMUTABILITY BY CONSTRUCTION, NOT BY TRIGGER
-- ---------------------------------------------
-- referred_wallet is the PRIMARY KEY, and no code path in this app ever
-- issues an UPDATE against this table -- claimReferral() in
-- lib/referral-server.ts only ever INSERTs with ON CONFLICT (referred_wallet)
-- DO NOTHING. That makes "first attribution wins, permanently" true by the
-- shape of the schema and the absence of any UPDATE statement, without
-- needing a BEFORE UPDATE trigger to enforce it. A different plank.love
-- sandbox on this same account used an explicit trigger for the same
-- guarantee -- both are valid; this one is simpler because this table
-- genuinely never needs an UPDATE for any other reason either.
--
-- WALLET-KEYED, NOT USER-KEYED
-- -----------------------------
-- This app has no user/identity table -- it is wallet-address-first
-- throughout (lib/wallet-context.tsx). Referral attribution follows that:
-- keyed directly on the lowercased wallet address, no separate identity
-- concept introduced.

CREATE TABLE IF NOT EXISTS plank_referrals (
  referred_wallet TEXT PRIMARY KEY,
  referrer_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plank_referrals_no_self_referral
    CHECK (referred_wallet <> referrer_wallet)
);

-- Every "how many people has X referred" read (ReferralPanel.tsx) filters by
-- referrer_wallet -- without this index that is a full table scan once the
-- table has any real volume.
CREATE INDEX IF NOT EXISTS plank_referrals_referrer_idx
  ON plank_referrals (referrer_wallet);
