-- Reconcile the original Woodstock prototype tables with the audio-first V1 API.
ALTER TABLE plankspace_live_rooms
  ADD COLUMN IF NOT EXISTS updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE plankspace_live_room_members
  ADD COLUMN IF NOT EXISTS requested_mic boolean NOT NULL DEFAULT false;
ALTER TABLE plankspace_live_room_members
  ADD COLUMN IF NOT EXISTS removed boolean NOT NULL DEFAULT false;
ALTER TABLE plankspace_live_room_members
  ADD COLUMN IF NOT EXISTS last_seen_at text NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The prototype allowed idle/requested/approved/muted; the shipped client uses
-- muted/unmuted and stores mic requests separately in requested_mic.
ALTER TABLE plankspace_live_room_members
  DROP CONSTRAINT IF EXISTS plankspace_live_room_members_mic_status_check;
UPDATE plankspace_live_room_members
SET mic_status = 'muted'
WHERE mic_status NOT IN ('muted', 'unmuted');
ALTER TABLE plankspace_live_room_members
  ADD CONSTRAINT plankspace_live_room_members_mic_status_check
  CHECK (mic_status IN ('muted', 'unmuted'));

CREATE INDEX IF NOT EXISTS live_rooms_status_updated_idx
  ON plankspace_live_rooms(status, updated_at);
CREATE INDEX IF NOT EXISTS live_room_members_presence_idx
  ON plankspace_live_room_members(room_slug, last_seen_at);
