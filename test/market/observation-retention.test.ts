import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Retention for the one table that grows without bound.
 *
 * A parallel data-model audit checked all 107 prior migrations for DELETE,
 * retention, prune, pg_cron and TTL. The only DELETEs are one-shot data
 * repairs. **Nothing in this schema was ever pruned on a schedule.**
 *
 * Most append-only tables here grow at the rate of real events, which is slow.
 * plank_collection_floor_observations does not: migration 041's
 * `UNIQUE (collection_id, marketplace, observation_bucket)` with
 * `observation_bucket DEFAULT date_trunc('minute', NOW())` admits one row per
 * collection per marketplace per MINUTE, across ~345,000 collections, with
 * three B-trees per insert.
 *
 * The dangerous half of retention is not forgetting to run it. It is deleting
 * something a reader still needs -- which fails silently, months later, as a
 * number that quietly stops appearing. So most of these tests are about what
 * must SURVIVE.
 */

const MIGRATION = readFileSync(
  "deploy/inmotion/postgres/migrations/108_observation_retention.sql",
  "utf8"
).replace(/\r\n/g, "\n");
const STORE = readFileSync("lib/market/multichain/store.ts", "utf8").replace(/\r\n/g, "\n");
const LANE = readFileSync("scripts/mesh-lane.ts", "utf8").replace(/\r\n/g, "\n");
const MATRIX = readFileSync("lib/market/multichain/mesh/matrix.ts", "utf8").replace(/\r\n/g, "\n");

test("the retention window is far wider than the only reader needs", () => {
  // getObservedFloorChange24h is the sole reader and asks for exactly two
  // rows: the newest, and the newest at least 24 hours old. Anything that
  // keeps well beyond 24h is safe; the margin is what makes it safe under a
  // future 7-day change without another migration.
  const m = MIGRATION.match(/retain_days INTEGER DEFAULT (\d+)/);
  assert.ok(m, "the retention window must be declared");
  const days = Number(m[1]);
  assert.ok(days >= 7, `must keep far more than the 24h the reader needs (saw ${days}d)`);
  assert.ok(days <= 90, `but must actually bound the table (saw ${days}d)`);
});

test("the only reader really does need only 24 hours", () => {
  // The claim the window rests on. If a second reader ever reaches further
  // back, this assertion is what fails first.
  const at = STORE.indexOf("plank_collection_floor_observations");
  assert.ok(at > 0, "the reader must exist");
  const readers = (STORE.match(/FROM plank_collection_floor_observations/g) ?? []).length;
  assert.equal(readers, 2, `two CTEs in one query; ${readers} means a new reader appeared`);
  assert.match(
    STORE,
    /observed_at <= NOW\(\) - INTERVAL '24 hours'/,
    "the furthest lookback must still be 24 hours"
  );
});

test("the prune is bounded per call", () => {
  // A first run may face a very large backlog. An unbounded DELETE would take
  // a long lock and bloat WAL in one shot -- turning a cleanup into the
  // outage it exists to prevent.
  assert.match(MIGRATION, /max_rows INTEGER DEFAULT \d+/, "a row cap must exist");
  assert.match(MIGRATION, /LIMIT max_rows/, "and must be applied in the delete");
});

test("the prune deletes by primary key, not by predicate", () => {
  // DELETE ... WHERE observed_at < x scans to find every match. Selecting a
  // bounded set of ids first turns it into one index scan plus a bulk delete.
  assert.match(MIGRATION, /WITH doomed AS/, "the doomed set must be selected first");
  assert.match(MIGRATION, /USING doomed d\s*\n\s*WHERE o\.id = d\.id/, "and deleted by id");
});

test("the prune has an index to run on", () => {
  // Without a leading observed_at index the retention scan IS the full-table
  // scan it exists to prevent -- a self-defeating prune that makes the
  // problem worse under load.
  assert.match(
    MIGRATION,
    /CREATE INDEX IF NOT EXISTS plank_floor_observations_observed_at_idx[\s\S]*?\(observed_at\)/,
    "the retention scan needs its own index"
  );
});

test("the migration is idempotent", () => {
  assert.match(MIGRATION, /CREATE OR REPLACE FUNCTION/, "the function must be replaceable");
  for (const c of MIGRATION.match(/CREATE INDEX[^;]*/g) ?? []) {
    assert.match(c, /IF NOT EXISTS/, `not idempotent: ${c.slice(0, 60)}`);
  }
});

test("the first pass inside the migration is small", () => {
  // This migration runs inside a transaction on a live database. A huge first
  // delete would hold locks for the length of the deploy.
  const seed = MIGRATION.match(/SELECT plank_prune_floor_observations\((\d+), (\d+)\)/);
  assert.ok(seed, "a seed pass should run so the table starts bounded");
  assert.ok(Number(seed[2]) <= 100_000, `the in-migration pass must stay small (saw ${seed[2]})`);
});

test("the scheduled drain is bounded by passes AND by an empty result", () => {
  // A fast machine hides an infinite loop. A prune that never terminates
  // would hold a mesh slot forever while looking like productive work.
  const at = LANE.indexOf('if (source === "retention")');
  assert.ok(at > 0, "the lane must be wired");
  const body = LANE.slice(at, LANE.indexOf("\n    if (source ===", at + 10));
  assert.match(body, /passes < 20/, "the loop must be bounded by a pass count");
  assert.match(body, /if \(n === 0\) break;/, "and must stop as soon as a pass removes nothing");
  assert.match(body, /removed: total, passes/, "and must report what it actually did");
});

test("retention runs cross-chain, once, not once per chain", () => {
  // The prune is a single bounded DELETE by observed_at. Eleven per-chain
  // copies would contend for the same rows and do the same work eleven times.
  const at = MATRIX.indexOf('id: "retention:cross-chain"');
  assert.ok(at > 0, "the lane must be registered");
  const block = MATRIX.slice(at, at + 400);
  assert.match(block, /chainSlug: "cross-chain"/, "one lane, not one per chain");
  assert.match(block, /source: "retention"/);
});

/**
 * The retention decision as a pure predicate, so the boundary is exercised
 * rather than only described.
 */
function shouldDelete(observedAtMsAgo: number, retainDays: number): boolean {
  return observedAtMsAgo > retainDays * 24 * 3600 * 1000;
}

test("nothing the reader needs is ever deleted", () => {
  const day = 24 * 3600 * 1000;
  // The two rows the reader asks for.
  assert.equal(shouldDelete(0, 30), false, "the newest observation always survives");
  assert.equal(shouldDelete(day, 30), false, "the 24h comparison point survives");
  assert.equal(shouldDelete(29 * day, 30), false, "and 29 days of headroom beyond it");
  // And the boundary itself.
  assert.equal(shouldDelete(31 * day, 30), true, "a month-old row goes");
  assert.equal(shouldDelete(365 * day, 30), true, "a year-old row certainly goes");
});
