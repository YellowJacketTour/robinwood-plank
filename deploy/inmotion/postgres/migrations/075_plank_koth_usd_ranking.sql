-- Real correctness fix, same day as 074: ranking a $PLANK KOTH buy by
-- ETH-wei paid alone is wrong -- one of the three canonical pools
-- (plank-pools.ts) pairs $PLANK with USDG, not WETH, so a fully legitimate
-- USDG-denominated buy would otherwise rank as literally 0 ETH and be
-- permanently unwinnable regardless of real value paid. Add a genuine
-- unified ranking column (USD value as an integer of micro-USD, so the
-- rule engine's plain BigInt comparison in king-of-the-hill-rules.ts stays
-- exact) and keep leading_eth_paid_wei/winner_eth_paid_wei as display-only
-- fields (0 for a pure-USDG buy, by design, never the ranking key).
ALTER TABLE plank_koth ADD COLUMN IF NOT EXISTS leading_value_micros NUMERIC(30, 0);
ALTER TABLE plank_koth ADD COLUMN IF NOT EXISTS winner_value_micros NUMERIC(30, 0);
