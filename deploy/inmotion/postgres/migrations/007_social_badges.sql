-- Wallet-signed badge attestations (verified collector / verified LP).
-- Lowest-priority piece of the social/curation layer — see migration 006's
-- follow/feed tables for the rest.
--
-- Zero custody, zero new contract: the same stateless wallet-proof
-- signature scheme lib/wallet-proof.ts already provides (also used by
-- lib/plank-checks.ts's wallet linking, migration 005). A badge is granted
-- only after the caller independently re-derives eligibility from real
-- chain/ledger data (e.g. a Plank Checks swap/LP point total over a
-- threshold) — this table only records the wallet's own signed claim
-- request alongside that grant, it never trusts a client-supplied
-- eligibility flag.
--
-- Additive only, safe against the immediately previous release.

CREATE TABLE IF NOT EXISTS social_badges (
  badge_id     BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  badge_type   TEXT NOT NULL, -- e.g. 'verified_collector', 'verified_lp'
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The signature that proved control of wallet_address at grant time
  -- (lib/wallet-proof.ts's WalletProof), kept for audit — never re-checked
  -- on read, since a badge's validity is the grant itself, not a live
  -- re-verification of a possibly-expired signature.
  proof_signature TEXT NOT NULL,
  proof_timestamp BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS social_badges_wallet_type_unique_idx
  ON social_badges (wallet_address, badge_type);

CREATE INDEX IF NOT EXISTS social_badges_wallet_idx
  ON social_badges (wallet_address);
