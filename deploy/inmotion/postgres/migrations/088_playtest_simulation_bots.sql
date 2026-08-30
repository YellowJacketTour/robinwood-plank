-- Server-owned, simulation-only participants. Bots have no credentials,
-- sessions, wallet authority, or mainnet identity. They reuse the ordinary
-- room/member/seat accounting paths so laboratory conservation stays honest.
ALTER TABLE playtest_users
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE playtest_room_members
  ADD COLUMN IF NOT EXISTS bot_profile JSONB;

CREATE INDEX IF NOT EXISTS playtest_room_members_bot_idx
  ON playtest_room_members (room_id)
  WHERE bot_profile IS NOT NULL;

-- Epoch-isolated linear stake tickets mirror the current Powerboard rule.
-- Historical rows remain auditable after a draw; a new epoch cannot consume
-- an older epoch's eligibility.
CREATE TABLE IF NOT EXISTS playtest_powerboard_tickets (
  room_id UUID NOT NULL REFERENCES playtest_rooms(id) ON DELETE CASCADE,
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  user_id UUID NOT NULL REFERENCES playtest_users(id),
  weight NUMERIC(78,0) NOT NULL CHECK (weight > 0),
  PRIMARY KEY (room_id, epoch, user_id)
);
