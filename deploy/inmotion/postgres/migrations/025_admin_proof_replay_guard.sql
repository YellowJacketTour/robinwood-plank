-- Single-use guard for admin wallet-signature proofs.
--
-- WHY (audit finding M2, 2026-08-19)
-- ----------------------------------
-- lib/admin-auth.ts's scheme is stateless by design: it binds action +
-- timestamp + payload hash, and accepts any signature whose timestamp is
-- within ADMIN_SIGNATURE_WINDOW_MS (5 minutes). That is sound against
-- cross-action and cross-payload reuse, but it is NOT single-use -- the
-- same valid request can be submitted repeatedly for the whole window.
--
-- For most admin actions that is harmless because they are idempotent by
-- nature (setting a flag to the same value, saving the same document).
-- The points grant is NOT: app/api/admin/points/route.ts calls
-- recordManualGrant -> recordPointEvent with NO sourceTxHash, and that
-- ledger's own dedup index is `ON CONFLICT (source_tx_hash, category,
-- wallet_address) WHERE source_tx_hash IS NOT NULL` -- so it never applies
-- to admin_grant rows. A captured request could therefore be replayed up
-- to the rate limit (20/min) for 5 minutes, each replay minting the full
-- grant again. Even an admin double-click double-grants.
--
-- This table makes any proof single-use: the proof's signature is hashed
-- and inserted BEFORE the privileged action runs, and the PRIMARY KEY
-- makes the second attempt fail. Generic (keyed by action too) so any
-- future non-idempotent admin action can opt in the same way.
--
-- Rows are prunable: anything older than the signature window can never
-- be replayed anyway, since verifyAdminProof would reject it as STALE.

CREATE TABLE IF NOT EXISTS plank_admin_proof_nonces (
  -- sha256 of the proof signature. Hashed rather than stored raw so the
  -- table is not itself a collection of reusable credentials.
  proof_hash  TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  address     TEXT NOT NULL,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports the cheap periodic prune described above.
CREATE INDEX IF NOT EXISTS plank_admin_proof_nonces_used_at_idx
  ON plank_admin_proof_nonces (used_at);
