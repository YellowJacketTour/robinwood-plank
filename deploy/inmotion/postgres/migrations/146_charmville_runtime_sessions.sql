-- Short-lived native-asset tickets retain the original PlankSpace session authority.
CREATE TABLE IF NOT EXISTS charmville_runtime_sessions (
 ticket_hash text PRIMARY KEY CHECK(ticket_hash ~ '^[a-f0-9]{64}$'),
 session_hash text NOT NULL REFERENCES plankspace_wallet_sessions(token_hash) ON DELETE CASCADE,
 profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS charmville_runtime_sessions_session_expiry
 ON charmville_runtime_sessions(session_hash,expires_at);
CREATE INDEX IF NOT EXISTS charmville_runtime_sessions_expiry
 ON charmville_runtime_sessions(expires_at);
