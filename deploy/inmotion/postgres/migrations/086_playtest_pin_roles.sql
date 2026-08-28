-- Shared-PIN laboratory identities carry an explicit simulation-only host
-- role. This grants no wallet, contract, marketplace, or relayer authority.
ALTER TABLE playtest_users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- The entrance model changed. Revoke pre-release sessions once so every
-- tester re-enters through the new PIN boundary after activation.
UPDATE playtest_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL;
