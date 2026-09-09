-- Charmville Phase A: storage only. Additive; runner supplies the transaction.
-- No starter grants on migration. The authenticated claim transaction creates
-- one yard per existing profile, six tilled plots, and two ready STALK crops.
-- Balances are server ledgers, never continuity-synced documents.

CREATE TABLE IF NOT EXISTS charmville_yards (
  profile_id BIGINT PRIMARY KEY REFERENCES plankspace_profiles(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  grain BIGINT NOT NULL DEFAULT 0 CHECK (grain >= 0),
  land_value NUMERIC(5,4) NOT NULL DEFAULT 0.8500
    CHECK (land_value BETWEEN 0.8500 AND 1.0000),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE IF NOT EXISTS charmville_plots (
  profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  plot_index INTEGER NOT NULL CHECK (plot_index >= 0),
  tilled BOOLEAN NOT NULL DEFAULT TRUE,
  crop TEXT CHECK (crop IN ('stalk', 'splinter')),
  cycle_id UUID,
  planted_at TIMESTAMPTZ,
  ripe_at TIMESTAMPTZ,
  compost_after TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (profile_id, plot_index),
  UNIQUE (cycle_id),
  CONSTRAINT charmville_original_plots_stay_tilled CHECK (plot_index >= 6 OR tilled),
  CONSTRAINT charmville_plot_state_complete CHECK (
    (crop IS NULL AND cycle_id IS NULL AND planted_at IS NULL
      AND ripe_at IS NULL AND compost_after IS NULL)
    OR
    (crop IS NOT NULL AND cycle_id IS NOT NULL AND planted_at IS NOT NULL
      AND ripe_at IS NOT NULL AND compost_after IS NOT NULL AND tilled
      AND ripe_at = planted_at + CASE crop
        WHEN 'stalk' THEN INTERVAL '4 hours' ELSE INTERVAL '16 hours' END
      AND compost_after = ripe_at + INTERVAL '48 hours')
  )
);

-- Separate tables make a seed impossible to mistake for a spendable face.
CREATE TABLE IF NOT EXISTS charmville_stacks (
  profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  face_id TEXT NOT NULL CHECK (face_id IN (
    'stalk', 'splinter', 'knock', 'hum', 'pith', 'gleam', 'knot'
  )),
  qty BIGINT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (profile_id, face_id)
);

CREATE TABLE IF NOT EXISTS charmville_seeds (
  profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  face_id TEXT NOT NULL CHECK (face_id IN (
    'stalk', 'splinter', 'knock', 'hum', 'pith', 'gleam', 'knot'
  )),
  qty BIGINT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (profile_id, face_id)
);

-- Receipts retain historical session identity, never the bearer token. Do not
-- FK to expiring session rows: routine session cleanup must not erase history.
CREATE TABLE IF NOT EXISTS charmville_receipts (
  id UUID PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  action TEXT NOT NULL CHECK (action IN ('claim', 'plant', 'harvest', 'compost', 'stamp', 'tend')),
  request_id UUID NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  actor_profile_id BIGINT NOT NULL REFERENCES plankspace_profiles(id),
  actor_wallet TEXT NOT NULL,
  session_hash TEXT NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  plot_index INTEGER,
  cycle_id UUID,
  face_id TEXT CHECK (face_id IN (
    'stalk', 'splinter', 'knock', 'hum', 'pith', 'gleam', 'knot'
  )),
  qty BIGINT NOT NULL DEFAULT 0 CHECK (qty >= 0),
  seed_delta BIGINT NOT NULL DEFAULT 0,
  grain_delta BIGINT NOT NULL DEFAULT 0,
  result JSONB NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_profile_id, request_id),
  FOREIGN KEY (profile_id, plot_index) REFERENCES charmville_plots(profile_id, plot_index),
  CONSTRAINT charmville_resolution_seed_return CHECK (
    action NOT IN ('harvest', 'compost') OR
    (seed_delta = 1 AND cycle_id IS NOT NULL AND plot_index IS NOT NULL AND face_id IS NOT NULL)
  ),
  CONSTRAINT charmville_compost_no_faces CHECK (action <> 'compost' OR qty = 0)
);

-- Harvest versus compost on the same planting cycle can resolve only once.
CREATE UNIQUE INDEX IF NOT EXISTS charmville_one_resolution_per_cycle
  ON charmville_receipts(cycle_id) WHERE action IN ('harvest', 'compost');
CREATE UNIQUE INDEX IF NOT EXISTS charmville_one_claim_per_profile
  ON charmville_receipts(profile_id) WHERE action = 'claim';
CREATE INDEX IF NOT EXISTS charmville_receipts_profile_created
  ON charmville_receipts(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS charmville_stamps (
  receipt_id UUID PRIMARY KEY REFERENCES charmville_receipts(id),
  profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  post_id BIGINT NOT NULL REFERENCES plankspace_posts(id),
  face_id TEXT NOT NULL CHECK (face_id IN ('stalk', 'splinter')),
  qty BIGINT NOT NULL CHECK (qty > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS charmville_stamps_post ON charmville_stamps(post_id);

CREATE TABLE IF NOT EXISTS charmville_tends (
  receipt_id UUID PRIMARY KEY REFERENCES charmville_receipts(id),
  actor_profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  target_profile_id BIGINT NOT NULL REFERENCES charmville_yards(profile_id),
  plot_index INTEGER NOT NULL,
  day_utc DATE NOT NULL,
  reward_slot SMALLINT NOT NULL CHECK (reward_slot BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (actor_profile_id <> target_profile_id),
  CHECK (day_utc = (created_at AT TIME ZONE 'UTC')::date),
  UNIQUE (actor_profile_id, target_profile_id, day_utc),
  UNIQUE (actor_profile_id, day_utc, reward_slot),
  FOREIGN KEY (target_profile_id, plot_index) REFERENCES charmville_plots(profile_id, plot_index)
);
