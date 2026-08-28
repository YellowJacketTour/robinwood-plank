-- Durable, simulation-only multiplayer rooms. No table in this namespace is a
-- custody ledger or source of mainnet authority.
CREATE TABLE IF NOT EXISTS playtest_rooms (
  id UUID PRIMARY KEY,
  join_code TEXT NOT NULL UNIQUE CHECK (join_code ~ '^[A-Z2-9]{8}$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 48),
  owner_user_id UUID NOT NULL REFERENCES playtest_users(id),
  rules_hash TEXT NOT NULL CHECK (rules_hash ~ '^[0-9a-f]{64}$'),
  policy JSONB NOT NULL,
  simulation_state JSONB NOT NULL,
  phase TEXT NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby', 'running', 'settled')),
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  current_round BIGINT NOT NULL DEFAULT 0 CHECK (current_round >= 0),
  commitment TEXT,
  reveal TEXT,
  crash_bps BIGINT,
  started_at TIMESTAMPTZ,
  crash_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS playtest_room_members (
  room_id UUID NOT NULL REFERENCES playtest_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES playtest_users(id) ON DELETE CASCADE,
  test_credit_balance NUMERIC(78,0) NOT NULL DEFAULT 1000000 CHECK (test_credit_balance >= 0),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS playtest_round_seats (
  room_id UUID NOT NULL REFERENCES playtest_rooms(id) ON DELETE CASCADE,
  round_id BIGINT NOT NULL CHECK (round_id > 0),
  user_id UUID NOT NULL REFERENCES playtest_users(id) ON DELETE CASCADE,
  stake NUMERIC(78,0) NOT NULL CHECK (stake > 0),
  requested_target_bps BIGINT NOT NULL CHECK (requested_target_bps >= 10100),
  accepted_target_bps BIGINT,
  command_id UUID NOT NULL,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  payout NUMERIC(78,0),
  net NUMERIC(78,0),
  survived BOOLEAN,
  PRIMARY KEY (room_id, round_id, user_id),
  UNIQUE (room_id, command_id)
);

CREATE TABLE IF NOT EXISTS playtest_room_events (
  sequence BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES playtest_rooms(id) ON DELETE CASCADE,
  room_version BIGINT NOT NULL,
  round_id BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES playtest_users(id),
  command_id UUID,
  public_payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, command_id)
);
CREATE INDEX IF NOT EXISTS playtest_room_events_room_sequence_idx
  ON playtest_room_events(room_id, sequence);
CREATE INDEX IF NOT EXISTS playtest_round_seats_room_round_idx
  ON playtest_round_seats(room_id, round_id);
