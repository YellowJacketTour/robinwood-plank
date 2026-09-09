CREATE TABLE IF NOT EXISTS charmville_world_presence (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id) ON DELETE CASCADE,
 home_owner_id bigint REFERENCES charmville_yards(profile_id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT '-infinity'
);
CREATE INDEX IF NOT EXISTS charmville_world_presence_region_idx ON charmville_world_presence(home_owner_id,expires_at);
