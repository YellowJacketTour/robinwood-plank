ALTER TABLE charmville_stacks DROP CONSTRAINT charmville_stacks_face_id_check;
ALTER TABLE charmville_stacks ADD CHECK(face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry'));
ALTER TABLE charmville_seeds DROP CONSTRAINT charmville_seeds_face_id_check;
ALTER TABLE charmville_seeds ADD CHECK(face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry'));
ALTER TABLE charmville_offers DROP CONSTRAINT charmville_offers_face_id_check;
ALTER TABLE charmville_offers ADD CHECK(face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry'));
CREATE TABLE charmville_native_seed_grants(profile_id bigint PRIMARY KEY REFERENCES charmville_yards(profile_id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE charmville_native_resources(
 region_id text NOT NULL,bed_id integer NOT NULL CHECK(bed_id BETWEEN 0 AND 2),
 stage integer NOT NULL DEFAULT 0 CHECK(stage BETWEEN 0 AND 3),revision bigint NOT NULL DEFAULT 0,
 planter_id bigint REFERENCES plankspace_profiles(id),ready_at timestamptz,
 PRIMARY KEY(region_id,bed_id)
);
CREATE TABLE charmville_native_actions(
 profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),request_id uuid NOT NULL,payload_hash text NOT NULL,
 region_id text NOT NULL,bed_id integer NOT NULL,kind text NOT NULL CHECK(kind IN ('till','plant','water','harvest')),
 resource_revision bigint NOT NULL,region_epoch bigint NOT NULL,sequence bigint NOT NULL,
 contact_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed','cancelled')),
 result jsonb,PRIMARY KEY(profile_id,request_id),FOREIGN KEY(region_id,bed_id) REFERENCES charmville_native_resources(region_id,bed_id)
);
CREATE UNIQUE INDEX charmville_one_native_action ON charmville_native_actions(profile_id) WHERE status='pending';
