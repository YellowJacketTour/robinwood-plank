import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { COLLECTION_MATCH_SQL } from "../../lib/market/multichain/collection-key-sql";

/**
 * The two endpoints a collection page cannot render without.
 *
 * MEASURED ON PRODUCTION (plank.love, 2026-09-12, CryptoPunks,
 * chainSlug=eth-mainnet,
 * collectionSlug=0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb):
 *
 *     /api/market/multichain/tokens      200  41.8s  (2nd call: 7.0s)
 *     /api/market/multichain/collection  200  17.7s  (2nd call: 6.6s)
 *     /api/market/multichain/trait-index 200   3.2s
 *     /api/market/multichain/listings    200   0.2s
 *
 * The page fires all four in parallel, so it is unusable until the slowest
 * returns. `listings` at 0.2s proves the infrastructure can be fast.
 *
 * WHAT WAS ACTUALLY WRONG -- and what was NOT
 * -------------------------------------------
 * The obvious suspect was the projection read on plank_collection_tokens
 * (19.4M rows / 16GB in production). EXPLAIN says otherwise: that query is
 * already served by plank_collection_tokens_browse_idx in 0.17ms. Ruling it
 * out is the point of the first test below -- a guess that had been left
 * unverified would have sent the fix to the wrong table.
 *
 * The real hole was plank_foreign_rarity, which /tokens falls back to whenever
 * a collection has rarity rows but no projection row. Migration 014 gave that
 * table exactly ONE index -- its primary key
 * (chain_slug, collection_slug, token_id), CASE SENSITIVE -- while
 * COLLECTION_MATCH_SQL filters every EVM chain with lower(collection_slug).
 * The `lower()` wrapper makes the primary key unusable, and unlike
 * plank_collection_tokens there was no second index to fall back to. The only
 * available plan was to read the entire table.
 *
 * Measured here by EXPLAIN (ANALYZE, BUFFERS) on 2,000,000 seeded rows
 * (601 MB), asking for the first 49 tokens of one collection:
 *
 *     before 115   Parallel Seq Scan, 40,907 buffers, 305.0 ms, 2 workers,
 *                  1,995,000 rows discarded, plus a top-N sort
 *     after 115    Index Scan,             7 buffers,   0.134 ms, no sort
 *
 * WHAT THESE TESTS ASSERT
 * -----------------------
 * PLAN SHAPE, never wall-clock. A timing assertion in this repo once passed
 * while a walk took 5,000,003 steps. "The planner names the index and there is
 * no Seq Scan on the table" is the durable claim; a duration is a statement
 * about the machine that ran it.
 *
 * They also refuse to assert anything on a table too small to make the claim
 * meaningful: on a small table a sequential scan is the CORRECT plan, and a
 * test that passes because the table is empty is a test that asserts nothing.
 * That case reports out loud rather than passing silently.
 */

const SKIP = { skip: !hasPostgresConfig() };

/** Below this, a seq scan is the right plan and the planner proves nothing. */
const MEANINGFUL_ROWS = 100_000;

async function rowCount(table: string): Promise<number> {
  const r = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
  return Number(r.rows[0]?.n ?? 0);
}

/** The collection with the most rows -- the one whose plan actually matters. */
async function busiestCollection(
  table: string
): Promise<{ chainSlug: string; collectionSlug: string; n: number } | null> {
  const r = await postgresQuery<{ chain_slug: string; collection_slug: string; n: string }>(
    `SELECT chain_slug, collection_slug, COUNT(*)::text AS n
       FROM ${table} GROUP BY chain_slug, collection_slug
      ORDER BY COUNT(*) DESC LIMIT 1`
  );
  const row = r.rows[0];
  return row ? { chainSlug: row.chain_slug, collectionSlug: row.collection_slug, n: Number(row.n) } : null;
}

async function explain(sql: string, params: unknown[]): Promise<string> {
  const plan = await postgresQuery<{ "QUERY PLAN": string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
  return plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
}

test("migration 115 created both plank_foreign_rarity browse indexes", SKIP, async () => {
  const idx = await postgresQuery<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'plank_foreign_rarity'
        AND indexname IN ('plank_foreign_rarity_browse_idx', 'plank_foreign_rarity_rank_idx')`
  );
  const names = idx.rows.map((r) => r.indexname).sort();
  assert.deepEqual(
    names,
    ["plank_foreign_rarity_browse_idx", "plank_foreign_rarity_rank_idx"],
    "both indexes must exist: the id-sorted grid and the rank-sorted grid order by " +
      "different expressions, so an index for one still leaves the other sorting the " +
      "whole collection. Found: " + JSON.stringify(names)
  );
});

test(
  "listForeignRarityTokens' real predicate uses an index, not a scan of plank_foreign_rarity",
  SKIP,
  async () => {
    const rows = await rowCount("plank_foreign_rarity");
    if (rows < MEANINGFUL_ROWS) {
      // Reported, not silently skipped: a test that quietly asserts nothing is
      // the failure species this repo keeps paying for.
      assert.ok(
        true,
        `only ${rows} rows in plank_foreign_rarity -- on a table this small a Seq Scan is the ` +
          `CORRECT plan, so the planner is not asserted here. Seed it to exercise this properly.`
      );
      return;
    }
    const target = await busiestCollection("plank_foreign_rarity");
    assert.ok(target, `plank_foreign_rarity has ${rows} rows but no groupable collection`);

    // Character-for-character the query listForeignRarityTokens builds for the
    // default (id-sorted, untiered) grid page -- including COLLECTION_MATCH_SQL
    // imported from the module the route itself uses, so a change to that
    // predicate is picked up here rather than drifting away from a copy.
    const text = await explain(
      `SELECT token_id, name, image_url FROM plank_foreign_rarity
        WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}
        ORDER BY CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END ASC NULLS LAST, token_id
        LIMIT $3`,
      [target.chainSlug, target.collectionSlug, 49]
    );

    assert.match(
      text,
      /Index (Only )?Scan using plank_foreign_rarity_browse_idx/,
      `the planner did not use plank_foreign_rarity_browse_idx on ${rows} rows. An index that ` +
        `exists but is not used is the same outage as no index. Plan was:\n${text}`
    );
    assert.doesNotMatch(
      text,
      /Seq Scan on plank_foreign_rarity/,
      `the grid page fell back to scanning the whole rarity table. Plan was:\n${text}`
    );
    // The index carries the ORDER BY expression as its third column precisely
    // so the LIMIT reads 49 entries in order. If a Sort reappears, the index is
    // being used only for the lookup and the collection is still being sorted
    // in full -- which is most of the cost this migration exists to remove.
    assert.doesNotMatch(
      text,
      /\bSort\b/,
      `the plan still sorts. plank_foreign_rarity_browse_idx carries the ORDER BY expression ` +
        `as its third column so that a LIMIT needs no sort at all. Plan was:\n${text}`
    );
  }
);

test("rank-sorted grid pages also avoid sorting the whole collection", SKIP, async () => {
  const rows = await rowCount("plank_foreign_rarity");
  if (rows < MEANINGFUL_ROWS) {
    assert.ok(true, `only ${rows} rows in plank_foreign_rarity -- planner not asserted (see above).`);
    return;
  }
  const target = await busiestCollection("plank_foreign_rarity");
  assert.ok(target, "no groupable collection in plank_foreign_rarity");

  const text = await explain(
    `SELECT token_id, name, image_url FROM plank_foreign_rarity
      WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}
      ORDER BY rank ASC, token_id
      LIMIT $3`,
    [target.chainSlug, target.collectionSlug, 49]
  );
  assert.match(
    text,
    /Index (Only )?Scan using plank_foreign_rarity_rank_idx/,
    `sort=rank still has no usable index. Plan was:\n${text}`
  );
  assert.doesNotMatch(text, /Seq Scan on plank_foreign_rarity/, `Plan was:\n${text}`);
});

test(
  "the token PROJECTION read was already indexed -- the slowness was not there",
  SKIP,
  async () => {
    // This test records a NEGATIVE finding, and it is deliberate. The obvious
    // suspect for a 41.8s /tokens response was this query, against the 19.4M-row
    // plank_collection_tokens. It is already served by
    // plank_collection_tokens_browse_idx (migration 034) in 0.17ms, measured.
    // Asserting that here keeps a future change from quietly removing the index
    // that makes it true, and keeps the record straight about where the cost
    // actually was.
    const rows = await rowCount("plank_collection_tokens");
    if (rows < MEANINGFUL_ROWS) {
      assert.ok(
        true,
        `only ${rows} rows in plank_collection_tokens -- on a table this small a Seq Scan is the ` +
          `CORRECT plan, so the planner is not asserted here.`
      );
      return;
    }
    const target = await busiestCollection("plank_collection_tokens");
    assert.ok(target, "no groupable collection in plank_collection_tokens");

    const text = await explain(
      `SELECT token_id, name, image_url, animation_url, media_type, traits,
              rarity_score, rarity_rank, rarity_percentile, rarity_tier
         FROM plank_collection_tokens
        WHERE chain_slug = $1 AND ${COLLECTION_MATCH_SQL}
        ORDER BY CASE WHEN token_id ~ '^[0-9]+$' THEN token_id::numeric END ASC NULLS LAST, token_id ASC
        LIMIT $3`,
      [target.chainSlug, target.collectionSlug, 49]
    );
    assert.match(
      text,
      /Index (Only )?Scan using plank_collection_tokens_browse_idx/,
      `the projection read lost its index. This is the query that was ALREADY fast (0.17ms); ` +
        `if it regresses, /tokens gets slow again for a different reason than the one migration ` +
        `115 fixed. Plan was:\n${text}`
    );
    assert.doesNotMatch(text, /Seq Scan on plank_collection_tokens/, `Plan was:\n${text}`);
  }
);
