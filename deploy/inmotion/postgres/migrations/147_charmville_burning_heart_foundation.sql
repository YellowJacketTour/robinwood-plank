-- Storage support only: no grants, bed conversion, market or native activation.
ALTER TABLE charmville_seeds DROP CONSTRAINT charmville_seeds_face_id_check;
ALTER TABLE charmville_seeds ADD CHECK (face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry','burning-heart'));
ALTER TABLE charmville_stacks DROP CONSTRAINT charmville_stacks_face_id_check;
ALTER TABLE charmville_stacks ADD CHECK (face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot','oran-berry','burning-heart'));
ALTER TABLE charmville_native_resources DROP CONSTRAINT charmville_native_resources_crop_id_check;
ALTER TABLE charmville_native_resources ADD CHECK (crop_id IN ('oran-berry','burning-heart'));
ALTER TABLE charmville_native_actions DROP CONSTRAINT charmville_native_actions_crop_id_check;
ALTER TABLE charmville_native_actions ADD CHECK (crop_id IN ('oran-berry','burning-heart'));

-- A separate versioned source receipt, never reusing the Oran starter grant.
-- Exactly three test seeds per profile; future versions need explicit migration.
CREATE TABLE charmville_family_entitlements (
 profile_id bigint NOT NULL REFERENCES charmville_yards(profile_id),
 version text NOT NULL CHECK (version = 'burning-heart-family-alpha-01'),
 seed_face text NOT NULL CHECK (seed_face = 'burning-heart'),
 seed_quantity integer NOT NULL CHECK (seed_quantity = 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (profile_id, version)
);
