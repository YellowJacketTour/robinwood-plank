CREATE TABLE charmville_creature_vitals(
 creature_id uuid PRIMARY KEY REFERENCES charmville_creature_entities(id),
 level integer NOT NULL CHECK(level BETWEEN 1 AND 100),
 hp_iv integer NOT NULL CHECK(hp_iv BETWEEN 0 AND 31),hp_ev integer NOT NULL CHECK(hp_ev BETWEEN 0 AND 255),
 hp integer NOT NULL CHECK(hp>=0),max_hp integer NOT NULL CHECK(max_hp>0 AND hp<=max_hp),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0)
);
CREATE TABLE charmville_creature_use_receipts(
 profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),request_id uuid NOT NULL,
 payload_hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(profile_id,request_id)
);
