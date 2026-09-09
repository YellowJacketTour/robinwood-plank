CREATE TABLE IF NOT EXISTS charmville_home_grants (
 owner_profile_id bigint NOT NULL REFERENCES charmville_yards(profile_id) ON DELETE CASCADE,
 visitor_profile_id bigint NOT NULL REFERENCES plankspace_profiles(id) ON DELETE CASCADE,
 rights text[] NOT NULL CHECK (rights <@ ARRAY['visit','help','harvest','build','storage']::text[] AND 'visit'=ANY(rights)),
 containers text[] NOT NULL DEFAULT '{}',
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_profile_id,visitor_profile_id),
 CHECK(owner_profile_id<>visitor_profile_id),
 CHECK(cardinality(containers)<=32),
 CHECK(NOT ('storage'=ANY(rights)) OR cardinality(containers)>0)
);
