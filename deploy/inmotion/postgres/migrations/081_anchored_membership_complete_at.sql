-- Real bug found live 2026-08-26 (systemic audit: "why doesn't this ever
-- reach 100%"): anchored_membership_complete (migration 073) is a
-- permanent, one-way latch -- once TRUE, isAnchoredMembershipComplete
-- short-circuits forever, so a collection's own real, later mints (minted
-- after the block this flag went true) are never scanned again. The scan
-- itself resumes incrementally from its own durable cursor (never a full
-- re-walk from deploy block), so periodic re-validation is cheap -- this
-- timestamp lets isAnchoredMembershipComplete treat completion as expiring
-- after a bounded TTL instead of forever, without adding any RPC call to
-- the cheap live-page-visit check itself.
ALTER TABLE plank_contract_deploy_block
  ADD COLUMN IF NOT EXISTS anchored_membership_completed_at TIMESTAMPTZ;
