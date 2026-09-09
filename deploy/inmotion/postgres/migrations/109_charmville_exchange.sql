CREATE TABLE IF NOT EXISTS charmville_offers (
 id UUID PRIMARY KEY,
 owner_profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
 side TEXT NOT NULL CHECK(side IN ('buy','sell')),
 face_id TEXT NOT NULL CHECK(face_id IN ('stalk','splinter','knock','hum','pith','gleam','knot')),
 price BIGINT NOT NULL CHECK(price BETWEEN 1 AND 1000000000),
 remaining BIGINT NOT NULL CHECK(remaining BETWEEN 0 AND 1000000),
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','filled','cancelled')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(state <> 'filled' OR remaining=0),
 CHECK(state <> 'open' OR remaining>0)
);
CREATE INDEX IF NOT EXISTS charmville_open_offers ON charmville_offers(face_id,side,price,created_at) WHERE state='open';
CREATE TABLE IF NOT EXISTS charmville_exchange_receipts (
 actor_profile_id BIGINT NOT NULL REFERENCES plankspace_profiles(id),
 request_id UUID NOT NULL,
 payload_hash TEXT NOT NULL,
 offer_id UUID NOT NULL REFERENCES charmville_offers(id),
 action TEXT NOT NULL CHECK(action IN ('create','fill','cancel')),
 quantity BIGINT NOT NULL CHECK(quantity>=0),
 grain BIGINT NOT NULL CHECK(grain>=0),
 result JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_profile_id,request_id)
);
