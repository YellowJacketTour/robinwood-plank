-- Durable, simulation-only personal PIN accounts and one-use room invites.
-- PIN material is scrypt-derived server-side; raw PINs are never stored.
ALTER TABLE playtest_users
  ADD COLUMN IF NOT EXISTS username_key TEXT,
  ADD COLUMN IF NOT EXISTS pin_salt TEXT,
  ADD COLUMN IF NOT EXISTS pin_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS playtest_users_username_key_uq
  ON playtest_users (username_key)
  WHERE username_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS playtest_invites (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by UUID NOT NULL REFERENCES playtest_users(id),
  room_id UUID REFERENCES playtest_rooms(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by UUID REFERENCES playtest_users(id)
);

CREATE INDEX IF NOT EXISTS playtest_invites_expiry_idx
  ON playtest_invites (expires_at)
  WHERE consumed_at IS NULL;

-- Shared-PIN identities were intentionally ephemeral. They cannot log in to
-- the personal-account model and their old sessions must not survive it.
UPDATE playtest_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL;
