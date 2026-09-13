CREATE TABLE IF NOT EXISTS charmville_spectator_settings (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id) ON DELETE CASCADE,
 mode text NOT NULL DEFAULT 'public' CHECK (mode IN ('public','private','allowlist')),
 allowed_ids bigint[] NOT NULL DEFAULT '{}',
 revision bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (cardinality(allowed_ids)<=100)
);
