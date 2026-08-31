-- A target typed in the HUD is not consent to execute it. Keep manual seats
-- unlocked unless the player explicitly arms auto-play or the server accepts
-- a live lock command. Existing seats default false to prevent retroactive wins.
ALTER TABLE playtest_round_seats
  ADD COLUMN IF NOT EXISTS auto_lock_enabled BOOLEAN NOT NULL DEFAULT FALSE;
