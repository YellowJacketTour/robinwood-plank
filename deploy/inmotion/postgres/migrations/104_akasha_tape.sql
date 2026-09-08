-- Akasha tape: the archive the hose owns.
--
-- Online-only. Every table here is new and nothing outside packages/akasha
-- reads or writes them, so applying this migration changes no existing
-- behaviour. It exists so the hose has somewhere durable to write; until a
-- hose process runs, these tables simply stay empty.
--
-- WHY THE akasha_ PREFIX. packages/akasha/sql/schema.sql declares these as
-- bare `event`, `header`, `cluster`, `observation`. Those names are far too
-- generic for a database this size -- the next unrelated migration that wants
-- a table called `event` would collide with the tape. The prefix also makes
-- the writer boundary visible in the database itself: anything named akasha_*
-- has exactly one legal writer.
--
-- THE WRITER RULE. The hose is the only process that may write akasha_cursor,
-- akasha_coverage_run, akasha_gap_queue, akasha_header and akasha_event. Two
-- writers on a tape is worse than the vendor ceiling it replaces, because a
-- tape with a second author cannot be replayed by a stranger.

CREATE TABLE IF NOT EXISTS akasha_cursor (
  chain             TEXT PRIMARY KEY,
  -- protocol_t0: first block where the watched event class can exist. A
  -- constant, reviewed like a consensus parameter, never moved by a worker.
  protocol_t0       BIGINT NOT NULL,
  -- archive_origin: first block actually held as part of a contiguous run.
  t0_hash           BYTEA NOT NULL,
  t0_height         BIGINT NOT NULL,
  tip_hash          BYTEA NOT NULL,
  tip_height        BIGINT NOT NULL,
  finalized_hash    BYTEA NOT NULL,
  finalized_height  BIGINT NOT NULL,
  -- backfill_tail: lowest block such that [tail, finalized] is the union of
  -- coverage runs. Moves LEFT only, and only by the gap worker.
  backfill_tail     BIGINT NOT NULL,
  stream_alive      BOOLEAN NOT NULL DEFAULT FALSE,
  stream_kind       TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS akasha_header (
  chain          TEXT NOT NULL,
  hash           BYTEA NOT NULL,
  parent_hash    BYTEA NOT NULL,
  height         BIGINT NOT NULL,
  logs_bloom     BYTEA,
  receipts_root  BYTEA,
  PRIMARY KEY (chain, hash)
);
CREATE INDEX IF NOT EXISTS akasha_header_height ON akasha_header (chain, height);

CREATE TABLE IF NOT EXISTS akasha_event (
  chain                 TEXT NOT NULL,
  block_hash            BYTEA NOT NULL,
  loc                   INTEGER NOT NULL,
  height                BIGINT NOT NULL,
  tx_hash               BYTEA NOT NULL,
  kind                  TEXT NOT NULL,
  contract_or_program   TEXT NOT NULL,
  token_or_inscription  TEXT NOT NULL,
  from_addr             TEXT NOT NULL,
  to_addr               TEXT NOT NULL,
  raw                   JSONB NOT NULL,
  -- (chain, block_hash, loc) not (chain, height, loc): two blocks can share a
  -- height, and a reorg deletes by hash. A height-keyed tape would take the
  -- survivor with the orphan.
  PRIMARY KEY (chain, block_hash, loc)
);
CREATE INDEX IF NOT EXISTS akasha_event_contract
  ON akasha_event (chain, contract_or_program, token_or_inscription);
CREATE INDEX IF NOT EXISTS akasha_event_height ON akasha_event (chain, height);

CREATE TABLE IF NOT EXISTS akasha_artifact (
  id            TEXT PRIMARY KEY,
  chain         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  genesis_hash  BYTEA NOT NULL,
  genesis_loc   INTEGER NOT NULL,
  first_hash    BYTEA NOT NULL,
  first_height  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS akasha_artifact_chain ON akasha_artifact (chain, kind);

CREATE TABLE IF NOT EXISTS akasha_coverage_run (
  chain           TEXT NOT NULL,
  from_height     BIGINT NOT NULL,
  to_height       BIGINT NOT NULL,
  to_hash         BYTEA NOT NULL,
  event_count     BIGINT NOT NULL,
  artifact_count  BIGINT NOT NULL,
  receipt_digest  BYTEA NOT NULL,
  PRIMARY KEY (chain, from_height)
);

CREATE TABLE IF NOT EXISTS akasha_gap_queue (
  id           BIGSERIAL PRIMARY KEY,
  chain        TEXT NOT NULL,
  from_height  BIGINT NOT NULL,
  to_height    BIGINT NOT NULL,
  -- Closed set. A gap with any other reason is a bug, not a job.
  reason       TEXT NOT NULL CHECK (reason IN
                 ('reconnect','reorg','bloom_audit','seq_gap','attention_history','epoch_backfill')),
  -- Required for attention_history: attention may schedule a backfill for an
  -- artifact the archive already holds, and may never invent a subject.
  artifact_id  TEXT,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts     INTEGER NOT NULL DEFAULT 0,
  claimed_at   TIMESTAMPTZ,
  CONSTRAINT akasha_gap_attention_needs_artifact
    CHECK (reason <> 'attention_history' OR artifact_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS akasha_gap_ready
  ON akasha_gap_queue (chain, claimed_at, id);

-- Completeness as a view, so the green dot cannot be computed from "last event
-- we saw". A chain is complete from its protocol origin only when the run-list
-- is a single hash-linked span.
CREATE OR REPLACE VIEW akasha_coverage_health AS
SELECT
  c.chain,
  c.protocol_t0,
  c.t0_height        AS archive_origin,
  c.backfill_tail,
  c.finalized_height,
  c.tip_height,
  c.stream_alive,
  (SELECT COUNT(*)     FROM akasha_coverage_run r WHERE r.chain = c.chain) AS run_count,
  (SELECT MIN(from_height) FROM akasha_coverage_run r WHERE r.chain = c.chain) AS run_from,
  (SELECT MAX(to_height)   FROM akasha_coverage_run r WHERE r.chain = c.chain) AS run_to,
  -- The sentence the UI is allowed to say, and only this one.
  (
    c.backfill_tail <= c.protocol_t0
    AND (SELECT COUNT(*) FROM akasha_coverage_run r WHERE r.chain = c.chain) = 1
    AND (SELECT MIN(from_height) FROM akasha_coverage_run r WHERE r.chain = c.chain) <= c.protocol_t0
    AND (SELECT MAX(to_height)   FROM akasha_coverage_run r WHERE r.chain = c.chain) >= c.finalized_height
  ) AS complete_from_protocol
FROM akasha_cursor c;
