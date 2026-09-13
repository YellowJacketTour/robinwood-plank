CREATE TABLE IF NOT EXISTS charmville_companions (
 id uuid PRIMARY KEY,
 owner_profile_id bigint NOT NULL UNIQUE REFERENCES charmville_yards(profile_id) ON DELETE CASCADE,
 source_species_id integer NOT NULL CHECK(source_species_id IN (277,280,283)),
 nickname text NOT NULL CHECK(length(nickname) BETWEEN 1 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
