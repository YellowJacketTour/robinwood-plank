-- Social / curation layer — follow a wallet or a collection, and surface
-- their activity as a feed. See docs/marketplank/SPEC-PLANK-CHECKS-AND-INDEX.md
-- §1 for the Plank Checks ledger this reuses as its activity source.
--
-- Deliberately does NOT fork or duplicate plank_checks_events (migration
-- 005) — that table is already the permanent, append-only record of real
-- on-chain-verified wallet activity (swap/lp_hold/deposit/redeem/sale/
-- referral/meme/volume_bounty). The feed query in lib/social-follows.ts
-- reads it directly, filtered to followed wallets, and (for followed
-- collections) to events whose metadata->>'collection' matches — a
-- free-form JSONB key any future event-recording caller may set, not a new
-- column, so this migration adds zero coupling to plank_checks_events.
--
-- Additive only, safe against the immediately previous release (a build
-- that has never heard of this table simply never queries it).

-- A wallet follows either another wallet OR a collection, never both in the
-- same row (enforced by the CHECK below) — two clean partial-unique indexes
-- keep "already following this wallet" / "already following this
-- collection" idempotent without a shared NULL-colliding UNIQUE constraint.
CREATE TABLE IF NOT EXISTS social_follows (
  follow_id            BIGSERIAL PRIMARY KEY,
  follower_wallet      TEXT NOT NULL,
  followed_wallet      TEXT,
  followed_collection  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_follows_exactly_one_target CHECK (
    (followed_wallet IS NOT NULL AND followed_collection IS NULL) OR
    (followed_wallet IS NULL AND followed_collection IS NOT NULL)
  ),
  CONSTRAINT social_follows_no_self_follow CHECK (
    followed_wallet IS NULL OR followed_wallet <> follower_wallet
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS social_follows_wallet_unique_idx
  ON social_follows (follower_wallet, followed_wallet)
  WHERE followed_wallet IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_follows_collection_unique_idx
  ON social_follows (follower_wallet, followed_collection)
  WHERE followed_collection IS NOT NULL;

-- "Who does this wallet follow" (profile / settings page).
CREATE INDEX IF NOT EXISTS social_follows_follower_idx
  ON social_follows (follower_wallet);

-- "Who follows this wallet/collection" (feed fan-out, follower counts).
CREATE INDEX IF NOT EXISTS social_follows_followed_wallet_idx
  ON social_follows (followed_wallet)
  WHERE followed_wallet IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_follows_followed_collection_idx
  ON social_follows (followed_collection)
  WHERE followed_collection IS NOT NULL;
