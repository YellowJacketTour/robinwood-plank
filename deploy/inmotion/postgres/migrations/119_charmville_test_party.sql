CREATE TABLE charmville_local_playtest_accounts(profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE charmville_creature_entities DROP CONSTRAINT charmville_creature_entities_acquisition_kind_check;
ALTER TABLE charmville_creature_entities ADD CHECK(acquisition_kind IN ('starter','capture','breeding','local-playtest'));
CREATE UNIQUE INDEX charmville_test_species_once ON charmville_creature_entities(owner_profile_id,source_species_id) WHERE acquisition_kind='local-playtest';
CREATE TABLE charmville_test_party_grants(profile_id bigint PRIMARY KEY REFERENCES charmville_local_playtest_accounts(profile_id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
