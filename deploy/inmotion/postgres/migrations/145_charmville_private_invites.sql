CREATE TABLE IF NOT EXISTS charmville_admission_invites (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 issued_by_profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),
 recipient_profile_id bigint REFERENCES plankspace_profiles(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 access_days integer NOT NULL CHECK (access_days BETWEEN 1 AND 90),
 revoked_at timestamptz,
 redeemed_at timestamptz,
 redeemed_by_profile_id bigint REFERENCES plankspace_profiles(id),
 granted_until timestamptz,
 CHECK (expires_at > created_at),
 CHECK ((redeemed_at IS NULL AND redeemed_by_profile_id IS NULL AND granted_until IS NULL)
     OR (redeemed_at IS NOT NULL AND redeemed_by_profile_id IS NOT NULL AND granted_until > redeemed_at))
);
CREATE INDEX IF NOT EXISTS charmville_admission_invites_created
 ON charmville_admission_invites(created_at DESC);
