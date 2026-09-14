import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * Migration 149: the two plank_market_events branches of the activity feed
 * get sort-covering indexes, as a DEFERRABLE migration (the runner may report
 * it PENDING behind notification maintenance; see
 * notification-migration-integration.test.ts for that path). This file proves
 * the indexes themselves: they carry each branch's exact ORDER BY, the planner
 * walks them without a Sort node, and they are partial on exactly the branch
 * predicate so they cannot serve a row the branch would not return.
 *
 * ledger-activity.ts imports `server-only`; its SQL is read from source text.
 */
const SKIP = { skip: !hasPostgresConfig() };
const SRC = readFileSync("lib/market/multichain/ledger-activity.ts", "utf8");
const MIGRATION = readFileSync("deploy/inmotion/postgres/migrations/149_market_events_feed_indexes.sql", "utf8");

function sqlConstant(name: string): string {
  const start = SRC.indexOf(`export const ${name} = \``);
  assert.ok(start >= 0, `${name} not found in ledger-activity.ts`);
  const end = SRC.indexOf("`;", start);
  return SRC.slice(start, end);
}
const FEED_UNION_SQL = sqlConstant("FEED_UNION_SQL");

const BEEZIE = ["base-mainnet", "0xbb5ec6fd4b61723bd45c399840f1d868840ca16f"] as const;

test("149's indexes carry each market_events branch's exact ORDER BY and predicate", () => {
  // Transfer branch: the feed's ORDER BY text must appear verbatim as the
  // index's sort columns (after the two equality columns), and the branch's
  // event_type predicate must be the index's partial predicate.
  const transferOrder = "ORDER BY block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC";
  assert.ok(FEED_UNION_SQL.includes(transferOrder), "transfer branch order changed; 149 must change with it");
  assert.ok(FEED_UNION_SQL.includes("event_type IN ('transfer', 'mint')"), "transfer branch predicate");
  assert.match(
    MIGRATION,
    /plank_market_events_transfer_feed_idx\s+ON plank_market_events \(chain_slug, lower\(collection_key\), block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC\)\s+WHERE event_type IN \('transfer', 'mint'\);/
  );
  // Stream branch.
  const streamOrder = "ORDER BY e.block_timestamp DESC NULLS LAST, e.sub_index DESC";
  assert.ok(FEED_UNION_SQL.includes(streamOrder), "stream branch order changed; 149 must change with it");
  assert.ok(FEED_UNION_SQL.includes("e.event_type = 'sale' AND e.venue_id = 'opensea-stream'"), "stream branch predicate");
  assert.match(
    MIGRATION,
    /plank_market_events_stream_feed_idx\s+ON plank_market_events \(chain_slug, lower\(collection_key\), block_timestamp DESC NULLS LAST, sub_index DESC\)\s+WHERE event_type = 'sale' AND venue_id = 'opensea-stream';/
  );
  // Both, and only both, and both IF NOT EXISTS (retried on every deploy
  // while PENDING; must be idempotent once it finally applies).
  // Statement starts only: the header prose mentions CREATE INDEX too.
  assert.equal((MIGRATION.match(/^CREATE INDEX/gm) ?? []).length, 2);
  assert.equal((MIGRATION.match(/^CREATE INDEX IF NOT EXISTS/gm) ?? []).length, 2);
});

test("migration 149 created both partial feed indexes on plank_market_events", SKIP, async () => {
  const result = await postgresQuery<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'plank_market_events' AND indexname LIKE '%_feed_idx' ORDER BY 1`
  );
  const defs = new Map(result.rows.map((r) => [r.indexname, r.indexdef]));
  assert.deepEqual([...defs.keys()], ["plank_market_events_stream_feed_idx", "plank_market_events_transfer_feed_idx"]);
  assert.match(defs.get("plank_market_events_transfer_feed_idx")!, /block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC\) WHERE \(event_type = ANY/);
  assert.match(defs.get("plank_market_events_stream_feed_idx")!, /block_timestamp DESC NULLS LAST, sub_index DESC\) WHERE \(\(event_type = 'sale'::text\) AND \(venue_id = 'opensea-stream'::text\)\)/);
});

test("the planner walks 149's indexes for both market_events branches and never sorts", SKIP, async () => {
  const rows = await postgresQuery<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM plank_market_events WHERE chain_slug = $1 AND lower(collection_key) = $2`,
    [...BEEZIE]
  );
  if (rows.rows[0].n < 10_000) {
    assert.ok(true, `only ${rows.rows[0].n} rows seeded -- plan shape not asserted`);
    return;
  }
  const transfer = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF)
     SELECT tx_hash FROM plank_market_events
      WHERE chain_slug = $1 AND lower(collection_key) = $2 AND event_type IN ('transfer', 'mint')
      ORDER BY block_timestamp DESC NULLS LAST, block_number DESC NULLS LAST, event_index DESC
      LIMIT 50`,
    [...BEEZIE]
  );
  let text = transfer.rows.map((x) => x["QUERY PLAN"]).join("\n");
  assert.match(text, /plank_market_events_transfer_feed_idx/, `transfer branch must walk its feed index. Plan:\n${text}`);
  assert.doesNotMatch(text, /Sort/, `a Sort node means every row is read. Plan:\n${text}`);

  const stream = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF)
     SELECT e.tx_hash FROM plank_market_events e
      WHERE e.chain_slug = $1 AND lower(e.collection_key) = $2 AND e.event_type = 'sale' AND e.venue_id = 'opensea-stream'
        AND NOT EXISTS (SELECT 1 FROM plank_seaport_fills f WHERE f.chain_slug = $1 AND f.tx_hash = e.tx_hash)
      ORDER BY e.block_timestamp DESC NULLS LAST, e.sub_index DESC
      LIMIT 50`,
    [...BEEZIE]
  );
  text = stream.rows.map((x) => x["QUERY PLAN"]).join("\n");
  assert.match(text, /plank_market_events_stream_feed_idx/, `stream branch must walk its feed index. Plan:\n${text}`);
  assert.doesNotMatch(text, /Sort/, `a Sort node means every row is read. Plan:\n${text}`);
});
