CREATE TABLE IF NOT EXISTS charmville_capture_events(
 id bigserial PRIMARY KEY,
 encounter_id uuid NOT NULL REFERENCES charmville_encounters(id),
 actor_profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),
 event_id uuid NOT NULL UNIQUE,
 actor_x integer NOT NULL,actor_y integer NOT NULL,
 target_x integer NOT NULL,target_y integer NOT NULL,
 captured boolean NOT NULL,shakes integer NOT NULL CHECK(shakes BETWEEN 0 AND 4),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS charmville_capture_events_encounter ON charmville_capture_events(encounter_id,id DESC);
