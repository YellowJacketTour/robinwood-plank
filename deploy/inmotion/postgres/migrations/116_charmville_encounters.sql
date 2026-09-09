CREATE TABLE charmville_encounters(
 id uuid PRIMARY KEY,region_id text UNIQUE NOT NULL,geometry_revision text NOT NULL,
 species_id integer NOT NULL,level integer NOT NULL,hp_iv integer NOT NULL,
 hp integer NOT NULL CHECK(hp>=0),max_hp integer NOT NULL CHECK(max_hp>0 AND hp<=max_hp),
 statuses text[] NOT NULL DEFAULT '{}',mode text NOT NULL DEFAULT 'world' CHECK(mode IN ('world','turn')),
 controller_id bigint REFERENCES plankspace_profiles(id),lease_until timestamptz,
 revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE charmville_encounter_receipts(
 profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),request_id uuid NOT NULL,
 payload_hash text NOT NULL,PRIMARY KEY(profile_id,request_id)
);
