import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { DEMAND_PRIORITY } from "../../lib/market/multichain/collection-demand";
import { requestActivityCoverage, ACTIVITY_COVERAGE_SOURCE } from "../../lib/market/multichain/activity-coverage";
import { claimDataJob } from "../../lib/market/multichain/control-plane";

/**
 * A coverage count is enqueued for a collection someone is LOOKING AT. It
 * must not be starved by the standing lane jobs that re-enqueue themselves
 * every tick.
 *
 * MEASURED live 2026-09-14: at priority 40, five of these sat queued with
 * ZERO attempts for four hours while the worker completed other sources
 * normally. The plain claim orders by `priority DESC`; standing lanes
 * re-enqueue at 20-60 forever. Anything at or below that band never runs.
 */
const SKIP = { skip: !hasPostgresConfig() };
const SRC = readFileSync("lib/market/multichain/activity-coverage.ts", "utf8");
const TICK = readFileSync("scripts/mesh-tick.ts", "utf8");

test("the coverage job outranks every standing lane job, by construction", () => {
  // The lane priorities the worker re-enqueues on every tick, read from the
  // scheduler itself rather than restated here.
  const lanePriorities = [...TICK.matchAll(/priority:\s*lane\.source[^,]*\?\s*(\d+)\s*:\s*(\d+)/g)]
    .flatMap((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(lanePriorities.length >= 2, `the lane priorities must be readable from mesh-tick; found ${lanePriorities.length}`);
  const highestLane = Math.max(...lanePriorities);
  assert.ok(
    DEMAND_PRIORITY.DETAIL_PAGE > highestLane,
    `a coverage count at ${DEMAND_PRIORITY.DETAIL_PAGE} must outrank the highest standing lane (${highestLane}), or it is starved`,
  );
  // And it must be the NAMED level, not a number that happens to be bigger.
  assert.match(SRC, /priority: DEMAND_PRIORITY\.DETAIL_PAGE/);
  assert.doesNotMatch(SRC, /priority: \d+/, "no bare priority number -- that is how 40 got in");
});

test("the claim really does order by priority, so the comparison above means something", () => {
  const control = readFileSync("lib/market/multichain/control-plane.ts", "utf8");
  assert.match(control, /j\.priority DESC, j\.attempts, j\.not_before, j\.id/, "the plain claim orders by priority DESC");
});

/**
 * The priority the module ACTUALLY enqueues at, taken by driving the real
 * requestActivityCoverage once and reading the row back -- not by restating
 * DEMAND_PRIORITY.DETAIL_PAGE here, which would make the ordering test pass
 * for a value the code never uses.
 */
async function coverageJobShape(): Promise<{ priority: number }> {
  const chain = "eth-mainnet";
  const probe = `0xzzprobe${Date.now().toString(16)}`.padEnd(42, "0").slice(0, 42);
  const key = `${ACTIVITY_COVERAGE_SOURCE}:${chain}:${probe}`;
  try {
    await requestActivityCoverage(chain, probe);
    const row = await postgresQuery<{ priority: number }>(
      `SELECT priority FROM plank_data_jobs WHERE job_key = $1`,
      [key]
    );
    assert.ok(row.rows[0], "requestActivityCoverage must enqueue a job");
    return { priority: row.rows[0].priority };
  } finally {
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key = $1`, [key]).catch(() => undefined);
  }
}

test("a queued coverage job is claimed ahead of a standing lane job", SKIP, async () => {
  // A chain slug unique to this run: `kind` is `mesh-lane:<chain>`, and the
  // claim filters on kind, so nothing else in the shared queue -- another
  // suite, CI's parallel files, a prior run's residue -- can be a candidate.
  // Isolation by construction rather than by hoping the queue is quiet.
  const chain = `zzchain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contract = `0xzzcov${Date.now().toString(16)}`.padEnd(42, "0").slice(0, 42);
  // Both rows also share a key prefix unique to this run, so cleanup can
  // delete exactly them. (The real enqueue path, job key and dedupe are
  // covered by activity-coverage.test.ts; what THIS test owns is the
  // ordering between the two priorities.)
  const prefix = `zzprio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}:`;
  const covKey = `${prefix}${ACTIVITY_COVERAGE_SOURCE}:${chain}:${contract}`;
  const laneKey = `${prefix}mesh:zztest-lane`;
  try {
    // The standing lane job FIRST, at the highest priority mesh-tick uses
    // (60), so ordering cannot come from insertion order; then the coverage
    // job at whatever priority the module actually asks for.
    const { priority: coveragePriority } = await coverageJobShape();
    await postgresQuery(
      `INSERT INTO plank_data_jobs (job_key, kind, source, chain_slug, subject, payload, priority, status, not_before)
       VALUES ($1, $2, 'seaport-fills', $3, NULL, '{}'::jsonb, 60, 'queued', NOW() - INTERVAL '1 minute'),
              ($4, $2, $5, $3, $6, '{}'::jsonb, $7, 'queued', NOW() - INTERVAL '1 minute')`,
      [laneKey, `mesh-lane:${chain}`, chain, covKey, ACTIVITY_COVERAGE_SOURCE, contract, coveragePriority]
    );

    // A PLAIN claim -- no jobKeyPrefix. Passing one switches claimDataJob to
    // the STANDING ordering (`h.last_claim_at, attempts, not_before, id`),
    // which ignores priority entirely and would silently disable the very
    // thing under test. Found exactly that way: with a prefix filter the
    // lane job won. The unique chain slug above is what keeps this claim off
    // everyone else's work.
    const job = await claimDataJob([`mesh-lane:${chain}`]);
    assert.ok(job, "one of this test's two jobs must be claimable");
    assert.ok(
      job!.jobKey.startsWith(prefix),
      `only this run's jobs carry kind mesh-lane:${chain}; got ${job!.jobKey}`,
    );
    assert.equal(
      job!.jobKey,
      covKey,
      `the visitor's count must be claimed before the standing lane job (got ${job!.jobKey} at priority order)`,
    );
    assert.equal(job!.source, ACTIVITY_COVERAGE_SOURCE);
    assert.equal(job!.subject, contract);
  } finally {
    // Only this run's own rows: the prefix is unique to it, so nothing else
    // in the shared queue is touched.
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key LIKE $1`, [`${prefix}%`]);
  }
});

after(closePostgres);
