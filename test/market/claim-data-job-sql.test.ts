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

    // A DIFFERENT job key: enqueueDataJob ratchets priority upward with
    // GREATEST(), so re-enqueuing the key above at 20 would keep its 120 and
    // the max-priority-60 claim would correctly refuse it. That ratchet is
    // deliberate (a click must never be demoted by a later background
    // enqueue), so the low-priority shape needs its own row.
    const cappedKey = `mesh:test-capped-${suffix}`;
    await enqueueDataJob({ jobKey: cappedKey, kind, source: `test-source-${suffix}`, chainSlug: "test-chain", subject: null, payload: {}, priority: 20 });
    const capped = await claimDataJob([kind], 60_000, undefined, 60);
    assert.equal(capped?.jobKey, cappedKey, "max-priority claim must return the low-priority job");
    if (capped) await finishDataJob(capped);
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key = $1`, [cappedKey]).catch(() => undefined);
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

test("a discovery-only worker claims only discovery lanes, and never a demand job", { skip: !hasPostgresConfig() }, async () => {
  const suffix = Date.now().toString(36);
  const kind = `mesh-lane:disc-${suffix}`;
  const discKey = `mesh:hypersync-discovery:disc-${suffix}`;
  const otherKey = `mesh:seaport-fills:disc-${suffix}`;
  try {
    // The non-discovery lane is made the OLDEST claim, so fair rotation alone
    // would pick it -- only the source filter can keep discovery first.
    await postgresQuery(
      `INSERT INTO mesh_lane_health (lane_key, last_claim_at, status, updated_at) VALUES ($1, now() - interval '9 days', 'ok', now())
       ON CONFLICT (lane_key) DO UPDATE SET last_claim_at = EXCLUDED.last_claim_at`,
      [`seaport-fills:disc-${suffix}`]
    );
    await enqueueDataJob({ jobKey: otherKey, kind, source: "seaport-fills", chainSlug: `disc-${suffix}`, subject: null, payload: {}, priority: 20 });
    await enqueueDataJob({ jobKey: discKey, kind, source: "hypersync-discovery", chainSlug: `disc-${suffix}`, subject: null, payload: {}, priority: 20 });

    const claimed = await claimDataJob([kind], 60_000, undefined, undefined, "mesh:", ["hypersync-discovery", "helius-discovery"]);
    assert.equal(claimed?.jobKey, discKey, "the discovery worker takes the discovery lane even though another lane waited longer");
    if (claimed) await finishDataJob(claimed);

    // With no discovery lane left, the filtered claim returns nothing (the
    // caller then falls back to the general queue rather than idling).
    const none = await claimDataJob([kind], 60_000, undefined, undefined, "mesh:", ["hypersync-discovery", "helius-discovery"]);
    assert.equal(none, null, "filtered claim does not spill over into non-discovery lanes");
  } finally {
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key = ANY($1::text[])`, [[discKey, otherKey]]).catch(() => undefined);
    await postgresQuery(`DELETE FROM mesh_lane_health WHERE lane_key = $1`, [`seaport-fills:disc-${suffix}`]).catch(() => undefined);
  }
});
