-- Canonical, IPFS-sourced RobinWood metadata store.
--
-- RobinWood is a fixed, fully-minted 1,542-token collection whose metadata
-- (name, description, image path, traits) is immutable after reveal. Prior
-- to this table, rarity/trait/collection reads derived that immutable data
-- from Blockscout on every cold rebuild — a MUTABLE, rate-limited third
-- party. Blockscout served pre-reveal stubs
-- ([{trait_type:"Status", value:"Unrevealed"}]) for planks #1-180 long after
-- reveal, which corrupted both those 180 tokens' display and the sample size
-- used to rank every other token.
--
-- This table is populated once (idempotently, resumable) by walking IPFS
-- directly — see lib/market/robinwood-metadata.ts and
-- `tsx scripts/refresh-market-data.ts --metadata`. It is additive only and
-- does not touch or replace any existing table; it is safe against the
-- immediately previous release (an app build that has never heard of this
-- table simply never queries it).
CREATE TABLE IF NOT EXISTS robinwood_token_metadata (
  token_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_uri TEXT NOT NULL,
  attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_cid TEXT NOT NULL,
  token_uri TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Supports trait-value lookups directly against the canonical store without
-- a full-table scan, if a future consumer wants that instead of the
-- in-memory trait index.
CREATE INDEX IF NOT EXISTS robinwood_token_metadata_attributes_idx
  ON robinwood_token_metadata USING GIN (attributes);
