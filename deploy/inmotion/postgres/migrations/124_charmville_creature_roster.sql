CREATE TABLE IF NOT EXISTS charmville_creature_entities (
 id uuid PRIMARY KEY,
 owner_profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),
 source text NOT NULL DEFAULT 'pokeemerald' CHECK(source='pokeemerald'),
 source_species_id integer NOT NULL CHECK(source_species_id>0),
 nickname text NOT NULL CHECK(length(nickname) BETWEEN 1 AND 32),
 acquisition_kind text NOT NULL CHECK(acquisition_kind IN ('starter','capture','breeding')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,owner_profile_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS charmville_one_starter_entity ON charmville_creature_entities(owner_profile_id) WHERE acquisition_kind='starter';
INSERT INTO charmville_creature_entities(id,owner_profile_id,source_species_id,nickname,acquisition_kind,created_at)
 SELECT id,owner_profile_id,source_species_id,nickname,'starter',created_at FROM charmville_companions ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS charmville_creature_rosters (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE IF NOT EXISTS charmville_creature_slots (
 profile_id bigint NOT NULL REFERENCES charmville_creature_rosters(profile_id),
 slot_index integer NOT NULL CHECK(slot_index BETWEEN 0 AND 5),
 creature_id uuid NOT NULL UNIQUE,
 PRIMARY KEY(profile_id,slot_index),
 FOREIGN KEY(creature_id,profile_id) REFERENCES charmville_creature_entities(id,owner_profile_id)
);
