CREATE TABLE IF NOT EXISTS charmville_native_actors (
 profile_id bigint PRIMARY KEY REFERENCES plankspace_profiles(id) ON DELETE CASCADE,
 region_id text NOT NULL,
 geometry_revision text NOT NULL,
 region_epoch bigint NOT NULL CHECK(region_epoch>=0),
 sequence bigint NOT NULL CHECK(sequence>=0),
 x integer NOT NULL CHECK(x>=0), y integer NOT NULL CHECK(y>=0),
 last_move_at bigint NOT NULL, last_checked_at bigint NOT NULL,
 version bigint NOT NULL DEFAULT 0
);
