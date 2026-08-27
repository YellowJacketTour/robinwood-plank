-- Permissioned Plank game laboratory. Authentication records are deliberately
-- isolated from economic/game state: possession of a passkey grants access to
-- simulations only and is never an on-chain signing authority.
CREATE TABLE IF NOT EXISTS playtest_users (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  invite_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS playtest_passkeys (
  credential_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES playtest_users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports TEXT[] NOT NULL DEFAULT '{}',
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS playtest_passkeys_user_idx ON playtest_passkeys(user_id);

CREATE TABLE IF NOT EXISTS playtest_ceremonies (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'authenticate')),
  challenge TEXT NOT NULL,
  user_id UUID,
  invite_hash TEXT,
  display_name TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS playtest_ceremonies_expiry_idx ON playtest_ceremonies(expires_at);

CREATE TABLE IF NOT EXISTS playtest_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES playtest_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS playtest_sessions_expiry_idx ON playtest_sessions(expires_at);
