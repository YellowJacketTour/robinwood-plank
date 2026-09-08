-- Release collections whose archive depth is measured against a MALL.
--
-- A multiplex core (Art Blocks, Manifold, Engine, shared 1155 factories) hosts
-- many projects behind one contract address, and its `totalSupply()` counts the
-- whole mall. `correctKnownSupplyFromChain` treated that read as authoritative,
-- REPLACED known_supply with it, and set known_supply_chain_confirmed = TRUE --
-- which then blocks every other correction path. One bad write curses the row
-- for its lifetime.
--
-- MEASURED ON PRODUCTION 2026-09-08. Friendship Bracelets by Alexis Andre
-- (eth-mainnet 0x942bc2d3e7a589fe5bd4a5c6ef9727dfd82f5c8a, Art Blocks
-- Explorations):
--
--   venue project supply      38,965
--   chain totalSupply()    2,000,335   <- the shared core, 51x larger
--   tokens actually held      39,153   <- MORE than the project has tokens
--   archive depth displayed     1.96%   = 39,153 / 2,000,335
--
-- The archive had already hydrated that project completely and reported 2%,
-- because it divided by the mall. Worse than a cosmetic error: completeness
-- checks compare COUNT(*) against known_supply, so metadata jobs for that
-- collection can never finish and hold a lane forever.
--
-- WHAT THIS DOES. Clears the cursed denominator wherever the stored supply is
-- more than 2x the venue's own project supply for the same collection, and
-- drops the chain_confirmed flag so a corrected value can be written later.
-- It does NOT invent a replacement: known_supply goes back to NULL, which the
-- scorer already handles honestly as scoreMethod 'unknown_supply' -- no
-- fabricated percentage. The application-side guard (this migration's sibling
-- change in archival-ledger.ts) stops the bad value being rewritten.
--
-- 2x is deliberately loose. A venue's total_supply legitimately lags a live
-- mint, so this must not fire on an ordinary collection that grew since its
-- last stats refresh. A mall is off by orders of magnitude, not by a factor of
-- two.
--
-- Additive in effect and idempotent: it only ever NULLs a value that is
-- provably wrong, and re-running finds nothing left to clear.

UPDATE collection_archival_stats s
SET known_supply = NULL,
    known_supply_chain_confirmed = FALSE
FROM plank_multichain_collections c
JOIN plank_multichain_snapshots snap ON snap.collection_id = c.id
WHERE s.chain_slug = c.chain_slug
  AND lower(s.collection_key) = lower(c.contract_address)
  AND s.known_supply IS NOT NULL
  AND snap.total_supply IS NOT NULL
  AND snap.total_supply > 0
  AND s.known_supply > snap.total_supply * 2;
