-- Private-alpha admission is attached to the existing PlankSpace account.
-- No bootstrap grants: deploys remain closed until an operator configures access.
CREATE TABLE IF NOT EXISTS charmville_admission_grants (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id),
 granted_by_profile_id bigint REFERENCES plankspace_profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 CHECK (expires_at > created_at),
 CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
