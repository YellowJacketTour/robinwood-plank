-- Allow the `incomplete_tx_walk` gap reason.
--
-- WHY THIS EXISTS
-- ---------------
-- A Bitcoin block whose transaction walk is truncated must NOT be recorded as
-- covered: the coverage run-list is the archive's completeness claim, and a run
-- for a block we only partly read makes that claim a lie. The adapter therefore
-- enqueues a gap instead.
--
-- That gap was being REJECTED. `incomplete_tx_walk` was added to the GapReason
-- union and to the runtime allowlist, but this CHECK still listed only the
-- original five plus `epoch_backfill`. Measured live 2026-09-09:
--
--   repair  ok 486  fail 23   "illegal gap reason incomplete_tx_walk"
--
-- So 23 truncated blocks produced NEITHER coverage NOR a gap -- the archive
-- silently forgot it had unfinished business with them. That is worse than
-- either outcome alone, and it is exactly the shape (work refused with no
-- durable record) the typed-hole model exists to prevent.
--
-- THREE ALLOWLISTS, ONE TRUTH. The GapReason union, gap.ts's LEGAL_REASONS and
-- this CHECK must agree. They did not: SQL has permitted `epoch_backfill` since
-- the tape was created and neither the type nor the runtime list contained it.
-- Both are corrected alongside this migration, and a test now asserts the three
-- against each other so drift fails CI instead of production.
--
-- The constraint is UNNAMED in migration 104, so Postgres generated
-- `akasha_gap_queue_reason_check`. Dropped IF EXISTS and recreated with a real
-- name, which only widens what is allowed -- no existing row can violate it.

ALTER TABLE akasha_gap_queue
  DROP CONSTRAINT IF EXISTS akasha_gap_queue_reason_check;
ALTER TABLE akasha_gap_queue
  DROP CONSTRAINT IF EXISTS akasha_gap_queue_reason_allowed;
ALTER TABLE akasha_gap_queue
  ADD CONSTRAINT akasha_gap_queue_reason_allowed
  CHECK (reason IN (
    'reconnect',
    'reorg',
    'bloom_audit',
    'seq_gap',
    'attention_history',
    'epoch_backfill',
    'incomplete_tx_walk'
  ));
