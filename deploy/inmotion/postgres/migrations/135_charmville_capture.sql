CREATE TABLE IF NOT EXISTS charmville_capture_supply(profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id),balls integer NOT NULL DEFAULT 3 CHECK(balls BETWEEN 0 AND 3));
ALTER TABLE charmville_encounters ADD COLUMN IF NOT EXISTS captured boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS charmville_capture_receipts(profile_id bigint NOT NULL REFERENCES plankspace_profiles(id),request_id uuid NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(profile_id,request_id));
