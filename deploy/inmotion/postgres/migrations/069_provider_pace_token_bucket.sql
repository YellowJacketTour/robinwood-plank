-- Token-bucket pacing mode -- for providers documented as a rate-over-window
-- (e.g. Alchemy's real "300 CU/s, ~10s rolling window" -- confirmed live
-- 2026-08-26 via alchemy.com/docs/reference/throughput) rather than a flat
-- minimum interval. Coexists in provider_pace_state (migration 065) with
-- the existing min_interval_ms mode's next_slot_at_ms column -- a given
-- pace_key only ever uses one mode's columns.
ALTER TABLE provider_pace_state
  ADD COLUMN IF NOT EXISTS tokens double precision,
  ADD COLUMN IF NOT EXISTS last_refill_at timestamptz;
