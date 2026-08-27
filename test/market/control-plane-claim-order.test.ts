import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { claimDataJob, enqueueDataJob, finishDataJob } from "../../lib/market/multichain/control-plane";

/**
 * Real starvation bug (2026-08-27): claimDataJob's tie-break used to be
 * (not_before, id) alone, so within one priority tier a job that keeps
 * failing and getting re-claimed (same low id, unchanged not_before)
 * permanently out-competed a newer, never-yet-tried job at the identical
 * priority -- confirmed live, a HyperSync-backed job sat at max priority
 * with zero claims all session while older, repeatedly-retrying jobs at
 * the same tier kept winning every round. This test proves the fix: at
 * equal priority, the job with FEWER attempts must be claimed first,
 * regardless of which one has the lower id / older not_before.
 */
test(
  "claimDataJob prefers the least-attempted job at equal priority, not the oldest id",
  { skip: !hasPostgresConfig() },
  async () => {
    const suffix = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const veteranKey = `test:claim-order:veteran:${suffix}`;
    const freshKey = `test:claim-order:fresh:${suffix}`;
    const kind = `test-claim-order:${suffix}`;
    try {
      // Veteran: inserted first (lower id), same priority, already failed
      // twice -- simulates a perpetually-retrying job.
      const veteranId = await enqueueDataJob({ jobKey: veteranKey, kind, source: "test", priority: 100 });
      const claimed1 = await claimDataJob([kind]);
      assert.equal(claimed1?.jobKey, veteranKey, "sanity: veteran is claimable alone");
      await finishDataJob({ id: claimed1!.id, leaseOwner: claimed1!.leaseOwner }, "simulated failure");
      await enqueueDataJob({ jobKey: veteranKey, kind, source: "test", priority: 100 });
      const claimed2 = await claimDataJob([kind]);
      await finishDataJob({ id: claimed2!.id, leaseOwner: claimed2!.leaseOwner }, "simulated failure");
      await enqueueDataJob({ jobKey: veteranKey, kind, source: "test", priority: 100 });

      // Fresh: inserted after the veteran (higher id), same priority,
      // never attempted.
      await enqueueDataJob({ jobKey: freshKey, kind, source: "test", priority: 100 });

      const winner = await claimDataJob([kind]);
      assert.equal(winner?.jobKey, freshKey, "the never-tried job must win the tie over the 2-attempts-deep veteran");
      await finishDataJob({ id: winner!.id, leaseOwner: winner!.leaseOwner });

      const veteranTurn = await claimDataJob([kind]);
      assert.equal(veteranTurn?.jobKey, veteranKey, "the veteran still gets its turn once the fresher job is claimed");
      await finishDataJob({ id: veteranTurn!.id, leaseOwner: veteranTurn!.leaseOwner });
      void veteranId;
    } finally {
      await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key IN ($1, $2)`, [veteranKey, freshKey]);
    }
  }
);
