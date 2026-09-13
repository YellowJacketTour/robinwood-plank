CREATE TABLE charmville_creature_rest(
 profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),request_id uuid NOT NULL,creature_id uuid NOT NULL REFERENCES charmville_creature_entities(id),
 region_epoch bigint NOT NULL,sequence bigint NOT NULL,ready_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','committed','cancelled')),PRIMARY KEY(profile_id,request_id)
);
CREATE UNIQUE INDEX charmville_one_rest ON charmville_creature_rest(profile_id) WHERE status='pending';
