CREATE TABLE charmville_battle_events(
 id bigserial PRIMARY KEY,encounter_id uuid NOT NULL REFERENCES charmville_encounters(id),
 actor_profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),turn bigint NOT NULL,
 log jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX charmville_battle_event_history ON charmville_battle_events(encounter_id,id DESC);
