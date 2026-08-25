-- Same fix as 075 applied to the "tower of top buys" display ranking: the
-- original 074 index ordered by eth_paid_wei, which would incorrectly rank
-- every real USDG-denominated buy as 0 (see 075's own header for the full
-- "why" -- one of the three canonical pools pairs $PLANK with USDG, not
-- WETH).
DROP INDEX IF EXISTS plank_koth_leaderboard_rank_idx;
CREATE INDEX IF NOT EXISTS plank_koth_leaderboard_rank_idx
  ON plank_koth_leaderboard (usd_value_at_buy DESC NULLS LAST, block_number ASC);
