/**
 * The activity feed's SQL, in a module without `server-only`.
 *
 * ledger-activity.ts imports `server-only`, which throws outside a React
 * Server Component -- so a worker (scripts/mesh-lane.ts, an esbuild bundle)
 * could never import the union to run the coverage count. The count moved
 * to the worker (activity-coverage.ts) precisely so the request path never
 * pays for it; the SQL it counts over lives here, where both can import it.
 *
 * UNION_SQL: the unbounded twelve-venue union -- counts and derivations.
 * FEED_UNION_SQL: the same branches, each bounded to the exact global key.
 */

export const UNION_SQL = `
  SELECT event_type AS kind, 'wallet-transfer' AS venue_id,
         tx_hash, event_index AS log_index, block_number::text AS block_number, block_timestamp,
         seller AS from_addr, buyer AS to_addr, token_id::text AS token_id, NULL::text AS batch_size,
         NULL::text AS currency_token, NULL::text AS price_wei
  FROM plank_market_events
  WHERE chain_slug = $1 AND lower(collection_key) = $2 AND event_type IN ('transfer', 'mint')

  UNION ALL
  -- OpenSea Stream sales (lib/market/multichain/edge/opensea-stream.ts):
  -- observed within seconds of the trade, no block number yet. Once the
  -- on-chain fill indexer has the same transaction, the indexed row wins
  -- and the stream row is excluded, so a sale never shows twice.
  SELECT 'sale', 'opensea-stream',
         e.tx_hash, e.sub_index AS log_index, NULL::text AS block_number, e.block_timestamp,
         e.seller, e.buyer, e.token_id::text, NULL,
         e.currency_address, e.amount_atomic::text
  FROM plank_market_events e
  WHERE e.chain_slug = $1 AND lower(e.collection_key) = $2 AND e.event_type = 'sale' AND e.venue_id = 'opensea-stream'
    AND NOT EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash)

  UNION ALL
  SELECT 'sale', 'seaport',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_seaport_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'wyvern',
         tx_hash, log_index, block_number::text, block_timestamp,
         maker, taker, token_id::text, NULL,
         NULL, price_wei::text
  FROM plank_wyvern_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'looksrare',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_looksrare_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'blur',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_blur_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'x2y2',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_x2y2_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'foundation',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         NULL, price_wei::text
  FROM plank_foundation_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT CASE WHEN direction = 'buy-from-pool' THEN 'pool-buy' ELSE 'pool-sell' END, 'sudoswap',
         tx_hash, log_index, block_number::text, block_timestamp,
         CASE WHEN direction = 'sell-to-pool' THEN counterparty ELSE pool_address END,
         CASE WHEN direction = 'buy-from-pool' THEN counterparty ELSE pool_address END,
         (token_ids[1])::text, array_length(token_ids, 1)::text,
         currency_token, price_wei::text
  FROM plank_sudoswap_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'rarible',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
  FROM plank_rarible_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT CASE WHEN auction_kind = 'sale' THEN 'sale' ELSE 'siring' END, 'cryptokitties-auction',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, winner, token_id::text, NULL,
         NULL, total_price_wei::text
  FROM plank_cryptokitties_fills
  WHERE chain_slug = $1 AND nft_contract = $2

  UNION ALL
  SELECT 'sale', 'cryptopunks-market',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         NULL, price_wei::text
  FROM plank_cryptopunks_fills
  WHERE chain_slug = $1 AND nft_contract = $2
`;

/**
 * THE GLOBAL TIMESTAMP BOUND -- exact top-N on plank_market_events with the
 * index that already exists, no new index needed.
 *
 * plank_market_events is 167 million rows / 110 GB on production (measured
 * 2026-09-14) and an anti-wraparound autovacuum holds it in SHARE UPDATE
 * EXCLUSIVE for as long as it takes, so the sort-covering indexes of
 * migration 149 stay PENDING behind that lock. Without them, the two
 * market_events branches read every row the collection has and sort
 * (Beezie: 1,155 ms locally with parallel workers; 9.6 has none).
 *
 * The existing plank_market_events_collection_time_idx is
 * (chain_slug, lower(collection_key), block_timestamp DESC). Walk it N rows
 * deep over the collection's timestamped transfers: the N-th newest
 * transfer's timestamp T. Then, for EVERY branch of the feed: a row with
 * timestamp < T cannot be in the global top-N, because at least N transfer
 * rows have timestamp >= T and the global key is timestamp-first, so all N
 * rank above it. Rows with timestamp >= T are therefore a superset of the
 * top-N of any branch, and each branch's own ORDER BY ... LIMIT over that
 * superset is exact. The argument uses only the transfer rows that exist;
 * it does not assume the transfer ledger is complete.
 *
 * The bound is the same for both market_events branches, so the stream
 * branch (whose own rows are too sparse to walk cheaply -- a collection
 * with no stream rows would walk its whole index) is bounded by the
 * transfer walk: `timestamp >= T` is one index range on the same index.
 *
 * NULL-timestamp rows sort last under the global key, so they can only
 * reach the top-N when fewer than N timestamped transfers exist -- exactly
 * when the walk returns no row and T is NULL. A second sub-branch per
 * table returns the NULL-timestamp rows only in that case; an OR inside
 * one branch cost the index range (361 ms measured) so the cases are
 * separate branches. When T is NULL the main branch's COALESCE makes the
 * bound -infinity and it returns every timestamped row -- fewer than N.
 *
 * Measured locally without 149's indexes, Beezie (44k rows, 6,285 stream):
 * both branches 1,155 ms -> 5.2 ms, 57 rows examined, no Sort over the
 * ledger.
 */
export const MARKET_EVENTS_TS_BOUND = `
  SELECT b.block_timestamp FROM plank_market_events b
   WHERE b.chain_slug = $1 AND lower(b.collection_key) = $2 AND b.event_type IN ('transfer', 'mint')
     AND b.block_timestamp IS NOT NULL
   ORDER BY b.block_timestamp DESC LIMIT 1 OFFSET $3::int - 1`;

/**
 * UNION_SQL with each branch bounded: ORDER BY the feed's EXACT global key,
 * then LIMIT $3, inside the branch. Same eleven ledgers, same column list,
 * same aliases -- only the shape of the read changes.
 *
 * WHY THE PER-BRANCH ORDER MUST BE THE GLOBAL KEY, EXACTLY
 * --------------------------------------------------------
 * readLedgerActivity's outer sort is
 *
 *   COALESCE(block_timestamp, epoch) DESC, block_number::numeric DESC NULLS LAST, log_index DESC
 *
 * If every branch is ordered by that same total order, the union of the
 * per-branch top-Ns is a superset of the true top-N, and the outer sort over
 * (11 x N) rows is exact. That is a structural property of top-N over a
 * union. It assumes nothing about the data.
 *
 * Two earlier designs assumed more and were WRONG. Each was caught by
 * comparing the bounded and unbounded top-50 as SETS on seeded data before
 * any code was written:
 *
 *   1. ORDER BY block_number DESC per branch, on the grounds that block
 *      height is a total order on time within one chain. True only when
 *      block_timestamp is monotone in block_number -- which un-backfilled
 *      timestamps violate, and which a cyclic seed violated first.
 *      BAYC: 50 of 50 rows differed.
 *   2. The same, with OpenSea-stream rows forced first via NULLS FIRST. The
 *      transfer branch of plank_market_events also holds stream-venue rows
 *      with NULL block_number, which a block-ordered bound mis-ranks -- and a
 *      permanent stream row (a venue the fill indexer never reaches) would
 *      float to the top forever. Beezie: 44 of 50 rows differed.
 *
 * With the exact key: BAYC 0/0, Beezie 0/0. `block_timestamp DESC NULLS LAST`
 * is the same order as `COALESCE(block_timestamp, epoch) DESC` for every real
 * timestamp, and unlike the COALESCE expression it is indexable -- migration
 * 148 gives each of the nine FILL branches an index of exactly this shape,
 * which is what lets the planner stop after N rows instead of reading the
 * collection's history and sorting it. Production is PostgreSQL 9.6: without
 * the tie-break column IN the index there is no incremental sort to fall
 * back on, and the branch reads every row.
 *
 * The two plank_market_events branches have NO such index yet. CREATE INDEX
 * on that table needs a SHARE lock, which the notification-maintenance lock
 * another role holds (SHARE UPDATE EXCLUSIVE) refuses; a must-apply
 * migration cannot take it, and the notification-migration-integration test
 * proved that before it reached production. Those two branches keep the
 * exact key -- so the feed stays exact -- and read what they read today,
 * then sort. Strictly no worse than before; the index is a cost question,
 * never a correctness one. See migration 148's header.
 *
 * The parenthesised subselects are required: ORDER BY / LIMIT inside a
 * UNION ALL member is only legal in that form.
 *
 * NOT used by the coverage aggregate or by deriveApproxHolderCountFromLedger.
 * Both are counts over every row and must stay on UNION_SQL.
 */
export const FEED_UNION_SQL = `
  (SELECT event_type AS kind, 'wallet-transfer' AS venue_id,
         tx_hash, event_index AS log_index, block_number::text AS block_number, block_timestamp,
         seller AS from_addr, buyer AS to_addr, token_id::text AS token_id, NULL::text AS batch_size,
         NULL::text AS currency_token, NULL::text AS price_wei
   FROM plank_market_events
   WHERE chain_slug = $1 AND lower(collection_key) = $2 AND event_type IN ('transfer', 'mint')
     AND block_timestamp >= COALESCE((${MARKET_EVENTS_TS_BOUND}), '-infinity'::timestamptz)
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'transfer', 'wallet-transfer',
         tx_hash, event_index AS log_index, block_number::text AS block_number, block_timestamp,
         seller AS from_addr, buyer AS to_addr, token_id::text AS token_id, NULL::text AS batch_size,
         NULL::text AS currency_token, NULL::text AS price_wei
   FROM plank_market_events
   WHERE chain_slug = $1 AND lower(collection_key) = $2 AND event_type IN ('transfer', 'mint')
     AND block_timestamp IS NULL AND (${MARKET_EVENTS_TS_BOUND}) IS NULL
   ORDER BY block_number DESC NULLS LAST, event_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'opensea-stream',
         e.tx_hash, e.sub_index AS log_index, NULL::text AS block_number, e.block_timestamp,
         e.seller, e.buyer, e.token_id::text, NULL,
         e.currency_address, e.amount_atomic::text
   FROM plank_market_events e
   WHERE e.chain_slug = $1 AND lower(e.collection_key) = $2 AND e.event_type = 'sale' AND e.venue_id = 'opensea-stream'
     AND e.block_timestamp >= COALESCE((${MARKET_EVENTS_TS_BOUND}), '-infinity'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash)
   ORDER BY e.block_timestamp DESC NULLS LAST, e.sub_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'opensea-stream',
         e.tx_hash, e.sub_index AS log_index, NULL::text AS block_number, e.block_timestamp,
         e.seller, e.buyer, e.token_id::text, NULL,
         e.currency_address, e.amount_atomic::text
   FROM plank_market_events e
   WHERE e.chain_slug = $1 AND lower(e.collection_key) = $2 AND e.event_type = 'sale' AND e.venue_id = 'opensea-stream'
     AND e.block_timestamp IS NULL AND (${MARKET_EVENTS_TS_BOUND}) IS NULL
     AND NOT EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash)
   ORDER BY e.sub_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'seaport',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
   FROM plank_seaport_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'wyvern',
         tx_hash, log_index, block_number::text, block_timestamp,
         maker, taker, token_id::text, NULL,
         NULL, price_wei::text
   FROM plank_wyvern_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'looksrare',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
   FROM plank_looksrare_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'blur',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
   FROM plank_blur_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'x2y2',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
   FROM plank_x2y2_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'foundation',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         NULL, price_wei::text
   FROM plank_foundation_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT CASE WHEN direction = 'buy-from-pool' THEN 'pool-buy' ELSE 'pool-sell' END, 'sudoswap',
         tx_hash, log_index, block_number::text, block_timestamp,
         CASE WHEN direction = 'sell-to-pool' THEN counterparty ELSE pool_address END,
         CASE WHEN direction = 'buy-from-pool' THEN counterparty ELSE pool_address END,
         (token_ids[1])::text, array_length(token_ids, 1)::text,
         currency_token, price_wei::text
   FROM plank_sudoswap_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'rarible',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         currency_token, price_wei::text
   FROM plank_rarible_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT CASE WHEN auction_kind = 'sale' THEN 'sale' ELSE 'siring' END, 'cryptokitties-auction',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, winner, token_id::text, NULL,
         NULL, total_price_wei::text
   FROM plank_cryptokitties_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)

  UNION ALL
  (SELECT 'sale', 'cryptopunks-market',
         tx_hash, log_index, block_number::text, block_timestamp,
         seller, buyer, token_id::text, NULL,
         NULL, price_wei::text
   FROM plank_cryptopunks_fills
   WHERE chain_slug = $1 AND nft_contract = $2
   ORDER BY block_timestamp DESC NULLS LAST, block_number DESC, log_index DESC
   LIMIT $3)
`;
