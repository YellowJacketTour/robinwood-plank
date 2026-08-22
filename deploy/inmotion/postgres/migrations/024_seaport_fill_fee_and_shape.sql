-- Records what each observed Seaport fill actually paid THIS marketplace,
-- and how its shape was interpreted.
--
-- WHY
-- ---
-- Points are now scored on fee-actually-received rather than sale price
-- (audit findings H2/H3 -- scoring price was farmable for free via
-- self-wash-trading or a self-minted worthless currency; see
-- seaport-fill-indexer.ts's writeFills for the full reasoning). That figure
-- is derived per-fill during decode, so it belongs on the row rather than
-- being recomputed later from data the row does not keep -- and it is also
-- the honest basis for any future "what did this app actually earn"
-- revenue reporting, which nothing else in this schema can currently
-- answer.
--
-- `shape` records whether the fill was read as a listing / bid / swap /
-- unknown (decodeOrderFulfilled's side-aware classification, rewritten for
-- audit finding H4). Keeping it makes a mis-decode diagnosable after the
-- fact instead of invisible, and lets analytics exclude `unknown` rather
-- than silently averaging it in.
--
-- Additive, defaulted, zero-downtime: every pre-existing row keeps a
-- truthful 0 fee (those fills were indexed before the fee was extracted,
-- so we genuinely do not know it) and 'unknown' shape.

ALTER TABLE plank_seaport_fills
  ADD COLUMN IF NOT EXISTS marketplace_fee_wei NUMERIC(78, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shape TEXT NOT NULL DEFAULT 'unknown';

-- "What has this marketplace earned, per chain, over time" -- the query
-- the fee column exists to make answerable. Partial: fee-bearing fills are
-- a small minority of all observed Seaport activity, so indexing only
-- those keeps this small.
CREATE INDEX IF NOT EXISTS plank_seaport_fills_fee_idx
  ON plank_seaport_fills (chain_slug, block_number DESC)
  WHERE marketplace_fee_wei > 0;
