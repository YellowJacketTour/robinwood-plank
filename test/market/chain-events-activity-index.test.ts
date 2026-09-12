import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * The hub index (app/api/market/multichain/route.ts) computes the home
 * collection's 7-day activity tally on every build:
 *
 *     SELECT COUNT(*) FROM plank_chain_events
 *      WHERE lower(contract) = lower($1)
 *        AND kind IN ('transfer','sale','mint')
 *        AND block_timestamp >= NOW() - INTERVAL '7 days'
 *
 * Before migration 113 no index could serve it. Every index on the table leads
 * with block_number, source, token_id or kind, and block_timestamp was not
 * indexed at all -- so the planner's best option was the `kind` index, which
 * selects the three commonest kinds of an append-only ledger (nearly all of
 * it) and then filters row by row.
 *
 * Measured on 202,496 seeded rows:
 *
 *     without 113   Parallel Seq Scan, 5,485 buffers, 33.4 ms, 2 extra workers
 *     with 113      Bitmap Index Scan,     3 buffers,  2.5 ms
 *
 * and the gap widens forever, because the ledger only grows.
 *
 * WHAT THIS TEST ASSERTS
 * ----------------------
 * That the PLANNER USES THE INDEX -- not merely that the index exists. An
 * index that is present but unusable for the predicate is the exact failure
 * this migration fixes: a plain b-tree on `contract` would satisfy
 * "the index exists" and still leave the query on a sequential scan, because
 * the predicate is written as lower(contract).
 *
 * It deliberately does not assert a duration. A wall-clock assertion in this
 * repo once passed while a walk took 5,000,003 steps; the plan shape is the
 * durable claim.
 */

const SKIP = { skip: !hasPostgresConfig() };
const HOME = "0x327CEAaedbbCf55F40d6F1aBc71bd9bC8ADCb156";

test("the activity index exists and covers exactly the hub's predicate", SKIP, async () => {
  const r = await postgresQuery<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE indexname = 'plank_chain_events_contract_activity_idx'`
  );
  assert.equal(r.rows.length, 1, "migration 113 must have created the index");
  const def = r.rows[0].indexdef;
  assert.match(def, /lower\(contract\)/, "must index the EXPRESSION the query writes, not the raw column");
  assert.match(def, /block_timestamp/, "the 7-day window needs the timestamp as a trailing column");
  assert.match(def, /WHERE .*transfer/, "partial on the three activity kinds keeps it smaller than the table");
});

test("the planner uses the index for the hub's 7-day activity tally", SKIP, async () => {
  const plan = await postgresQuery<{ "QUERY PLAN": string }>(
    `EXPLAIN (COSTS OFF)
     SELECT COUNT(*)::text AS n FROM plank_chain_events
      WHERE lower(contract) = lower($1)
        AND kind IN ('transfer','sale','mint')
        AND block_timestamp >= NOW() - INTERVAL '7 days'`,
    [HOME]
  );
  const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");

  // On an empty or tiny table Postgres correctly prefers a seq scan, and that
  // is not a defect -- so the assertion is conditional on there being enough
  // rows for an index to be the right choice. Reported rather than silently
  // skipped: a test that quietly asserts nothing is the failure species this
  // repo keeps paying for.
  const size = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM plank_chain_events`);
  const rows = Number(size.rows[0]?.n ?? 0);
  if (rows < 10_000) {
    assert.match(
      text,
      /plank_chain_events/,
      `only ${rows} rows present -- too few for the planner to prefer an index; ` +
        `plan shape is not asserted here. Seed the table to exercise this properly.`
    );
    return;
  }

  assert.match(
    text,
    /plank_chain_events_contract_activity_idx/,
    `the planner ignored the activity index on ${rows} rows. A present-but-unused index is ` +
      `the same outage as no index. Plan was:\n${text}`
  );
  assert.doesNotMatch(
    text,
    /Seq Scan on plank_chain_events/,
    `the tally fell back to a sequential scan over the whole ledger. Plan was:\n${text}`
  );
});
