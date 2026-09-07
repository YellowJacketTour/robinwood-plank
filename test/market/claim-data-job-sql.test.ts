import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { claimDataJob, enqueueDataJob, finishDataJob } from "../../lib/market/multichain/control-plane";

/**
 * The claim query must EXECUTE, not merely typecheck (2026-09-07).
 *
 * A standing-slot rotation shipped with a correlated subquery inside the
 * ORDER BY of a `SELECT ... FOR UPDATE`. Postgres rejects that combination,
 * so every standing claim threw, the worker saw "no job", and no discovery,
 * hunter or parity lane ran for six hours on production while the queue
 * held thousands of ready jobs. Nothing in the suite executed the SQL, so
 * CI was green throughout. These tests run the real function in all four
 * claim shapes against a real database.
 */
test("claimDataJob executes in every shape: general, express floor, standing prefix, kind filter", { skip: !hasPostgresConfig() }, async () => {
  const suffix = Date.now().toString(36);
  const kind = `mesh-lane:test-${suffix}`;
  const laneKey = `test-source-${suffix}:test-chain`;
  const jobKey = `mesh:test-${suffix}`;
  try {
    await postgresQuery(
      `INSERT INTO mesh_lane_health (lane_key, last_claim_at, status, updated_at) VALUES ($1, now() - interval '1 day', 'ok', now())
       ON CONFLICT (lane_key) DO UPDATE SET last_claim_at = EXCLUDED.last_claim_at`,
      [laneKey]
    );
    await enqueueDataJob({ jobKey, kind, source: `test-source-${suffix}`, chainSlug: "test-chain", subject: null, payload: {}, priority: 20 });

    // Standing shape: the one that was broken. It must both run AND return the job.
    const standing = await claimDataJob([kind], 60_000, undefined, undefined, "mesh:");
    assert.ok(standing, "standing claim (job_key prefix + lane-health ordering) must return the queued lane");
    assert.equal(standing.jobKey, jobKey);
    await finishDataJob(standing);

    // General shape.
    await enqueueDataJob({ jobKey, kind, source: `test-source-${suffix}`, chainSlug: "test-chain", subject: null, payload: {}, priority: 20 });
    const general = await claimDataJob([kind], 60_000);
    assert.ok(general, "general claim must return the queued job");
    await finishDataJob(general);

    // Express shape (priority floor) and a max-priority shape: both must EXECUTE.
    await enqueueDataJob({ jobKey, kind, source: `test-source-${suffix}`, chainSlug: "test-chain", subject: null, payload: {}, priority: 120 });
    const express = await claimDataJob([kind], 60_000, 118);
    assert.ok(express, "express claim must return the high-priority job");
    await finishDataJob(express);

    await enqueueDataJob({ jobKey, kind, source: `test-source-${suffix}`, chainSlug: "test-chain", subject: null, payload: {}, priority: 20 });
    const capped = await claimDataJob([kind], 60_000, undefined, 60);
    assert.ok(capped, "max-priority claim must return the low-priority job");
    await finishDataJob(capped);
  } finally {
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key = $1`, [jobKey]).catch(() => undefined);
    await postgresQuery(`DELETE FROM mesh_lane_health WHERE lane_key = $1`, [laneKey]).catch(() => undefined);
  }
});

test("standing rotation prefers the least-recently-CLAIMED lane, not the least-recently-completed", { skip: !hasPostgresConfig() }, async () => {
  const suffix = Date.now().toString(36);
  const kind = `mesh-lane:rot-${suffix}`;
  const stale = { source: `rot-stale-${suffix}`, key: `mesh:rot-stale-${suffix}` };
  const fresh = { source: `rot-fresh-${suffix}`, key: `mesh:rot-fresh-${suffix}` };
  try {
    for (const [lane, ago] of [[stale, "2 days"], [fresh, "1 minute"]] as const) {
      await postgresQuery(
        `INSERT INTO mesh_lane_health (lane_key, last_claim_at, status, updated_at) VALUES ($1, now() - $2::interval, 'ok', now())
         ON CONFLICT (lane_key) DO UPDATE SET last_claim_at = EXCLUDED.last_claim_at`,
        [`${lane.source}:rot-chain`, ago]
      );
      await enqueueDataJob({ jobKey: lane.key, kind, source: lane.source, chainSlug: "rot-chain", subject: null, payload: {}, priority: 20 });
    }
    const claimed = await claimDataJob([kind], 60_000, undefined, undefined, "mesh:");
    assert.equal(claimed?.jobKey, stale.key, "the lane not claimed for two days goes before the one claimed a minute ago");
    if (claimed) await finishDataJob(claimed);
  } finally {
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key = ANY($1::text[])`, [[stale.key, fresh.key]]).catch(() => undefined);
    await postgresQuery(`DELETE FROM mesh_lane_health WHERE lane_key = ANY($1::text[])`, [[`${stale.source}:rot-chain`, `${fresh.source}:rot-chain`]]).catch(() => undefined);
  }
});
