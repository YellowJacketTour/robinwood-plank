-- Endorsement storage layer for lib/social-rankings.ts's
-- rankByWeightedEndorsements — see migration 006_social_curation.sql for the
-- follow/feed tables this complements.
--
-- PR #21 shipped rankByWeightedEndorsements as pure scoring math with no
-- backing table at all: nothing recorded who endorsed what, so there was no
-- way to (a) persist a real endorsement, or (b) stop a single wallet from
-- endorsing an unbounded number of targets at full weight each. This table
-- is that storage layer. The per-voter dilution that turns "unlimited
-- targets at full weight" into a bounded contribution lives in
-- lib/social-rankings.ts (see its rankByWeightedEndorsements doc comment) —
-- this migration only has to guarantee one endorsement per (voter, target)
-- pair so a voter cannot stack weight on the same target twice.
--
-- Additive only, safe against the immediately previous release (a build
-- that has never heard of this table simply never queries it).

CREATE TABLE IF NOT EXISTS social_endorsements (
  endorsement_id BIGSERIAL PRIMARY KEY,
  voter_wallet   TEXT NOT NULL,
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_endorsements_target_type_check CHECK (
    target_type IN ('wallet', 'collection')
  ),
  -- One live endorsement per voter per target — no stacking multiple
  -- endorsements from the same wallet toward the same target to inflate its
  -- score. A voter who wants to change their mind unendorses (deletes the
  -- row) and endorses again; they never accumulate duplicates.
  CONSTRAINT social_endorsements_voter_target_unique UNIQUE (
    voter_wallet, target_type, target_id
  )
);

-- "What has this voter endorsed" — used to compute a voter's live
-- endorsement count for the per-voter dilution factor (see
-- lib/social-rankings.ts) and to render "you already endorsed this" in the
-- UI without a second query.
CREATE INDEX IF NOT EXISTS social_endorsements_voter_idx
  ON social_endorsements (voter_wallet);

-- "Who has endorsed this target" — feeds rankByWeightedEndorsements, which
-- needs every live endorsement for a batch of targets at once.
CREATE INDEX IF NOT EXISTS social_endorsements_target_idx
  ON social_endorsements (target_type, target_id);
