-- Real bug found live 2026-08-25 ("no sync, no progress" on MAYC after a
-- long wait, despite max priority): wiring anchored-membership into every
-- EVM collection's real page-visit demand path (fixed earlier tonight)
-- created an unbounded, ever-growing queue where an ALREADY-COMPLETE
-- collection's job kept getting senselessly re-enqueued on every repeat
-- visit -- and because its not_before was pinned to the earliest moment
-- it was ever enqueued (enqueueDataJob's own LEAST() ratchet), it
-- PERMANENTLY won every priority tie over every other, genuinely
-- incomplete collection's real anchored work, forever. This flag lets
-- the demand layer skip enqueueing entirely for a collection whose real
-- chain-tip walk is already proven done, instead of relying on cheap-
-- but-still-real per-visit reclaims to crowd out real, unfinished work.
ALTER TABLE plank_contract_deploy_block
  ADD COLUMN IF NOT EXISTS anchored_membership_complete BOOLEAN NOT NULL DEFAULT FALSE;
