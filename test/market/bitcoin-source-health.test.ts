import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { claimDataJob, deferDataJob, enqueueDataJob, ordiscanBackgroundDayWindow } from "../../lib/market/multichain/control-plane";
import { getLaneHealth, recordLaneClaim, recordLaneDeferred, recordLaneOutcome, summarizeLaneHealthByChain } from "../../lib/market/multichain/mesh/lane-health";
import { runMeshLaneDetailed } from "../../scripts/mesh-lane";

test("retired OpenSea Bitcoin lane is not a live outage; deferred capacity remains visible", () => {
  const at = "2026-09-09T00:00:00Z";
  const summary = summarizeLaneHealthByChain([
    { laneKey: "opensea-stats:bitcoin-mainnet", lastClaimAt: at, lastSuccessAt: at, status: "backoff" },
    { laneKey: "ordiscan-discovery:bitcoin-mainnet", lastClaimAt: at, lastSuccessAt: at, status: "jailed" },
    { laneKey: "adapter-sync:bitcoin-mainnet", lastClaimAt: at, lastSuccessAt: at, status: "backoff" },
  ]);
  assert.deepEqual(summary["bitcoin-mainnet"]?.down.map(row => [row.source, row.reason]), [
    ["ordiscan-discovery", "paused"], ["adapter-sync", "backoff"],
  ]);
});

test("standing re-enqueue preserves a real provider deferral; no false successful health timestamp", { skip: !hasPostgresConfig() }, async () => {
  const key = `test:capacity:${Date.now()}`;
  const kind = key;
  const lane = key;
  try {
    await enqueueDataJob({jobKey: key, kind, source: "test"});
    const claimed = await claimDataJob([kind]);
    assert.ok(claimed);
    await recordLaneClaim(lane);
    await recordLaneOutcome(lane, true);
    const previous = (await getLaneHealth()).find(row => row.laneKey === lane)?.lastSuccessAt;
    const resumes = new Date(Date.now() + 60_000);
    await deferDataJob(claimed, resumes, "provider capacity");
    await recordLaneDeferred(lane);
    await enqueueDataJob({jobKey: key, kind, source: "test", preserveNotBefore: true});
    assert.equal(await claimDataJob([kind]), null, "maintenance must not pull a deferred job forward");
    const row = (await getLaneHealth()).find(row => row.laneKey === lane);
    assert.deepEqual(row?.lastSuccessAt, previous, "waiting is not a successful source read");
    assert.equal(row?.status, "jailed");
    await postgresQuery("UPDATE plank_data_jobs SET not_before=NOW()-INTERVAL '1 second' WHERE job_key=$1", [key]);
    assert.equal((await claimDataJob([kind]))?.jobKey, key, "work resumes after its deadline");
  } finally {
    await postgresQuery("DELETE FROM plank_data_jobs WHERE job_key=$1", [key]);
    await postgresQuery("DELETE FROM mesh_lane_health WHERE lane_key=$1", [lane]);
  }
});

test("exhausted Ordiscan capacity returns a scheduled retry without any HTTP call", { skip: !hasPostgresConfig() }, async () => {
  const window = ordiscanBackgroundDayWindow();
  assert.equal(window.allowance, 32);
  assert.ok(31 * window.allowance <= 1000);
  const original = (await postgresQuery("SELECT * FROM plank_provider_windows WHERE provider_account='ordiscan:default' AND window_key='day' AND window_started_at=$1", [window.startsAt])).rows[0];
  const originalKey = process.env.ORDISCAN_API_KEY;
  const originalFetch = globalThis.fetch;
  try {
    await postgresQuery(`INSERT INTO plank_provider_windows(provider_account,window_key,window_started_at,window_ends_at,allowance,reserved,consumed)
      VALUES ('ordiscan:default','day',$1,$2,32,0,32)
      ON CONFLICT(provider_account,window_key,window_started_at) DO UPDATE SET allowance=32,reserved=0,consumed=32`, [window.startsAt, window.endsAt]);
    process.env.ORDISCAN_API_KEY = "test-unused-key";
    globalThis.fetch = async () => { throw new Error("capacity gate must not issue HTTP"); };
    const result = await runMeshLaneDetailed("ordiscan-discovery", "bitcoin-mainnet");
    assert.equal(result.code, 0);
    assert.ok(result.deferMs && result.deferMs > 0);
    assert.ok(Math.abs(Date.now() + result.deferMs - window.endsAt.getTime()) < 2000);
    assert.match(result.deferReason ?? "", /provider capacity resumes/);
    assert.equal(result.error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ORDISCAN_API_KEY; else process.env.ORDISCAN_API_KEY = originalKey;
    if (original) await postgresQuery(`UPDATE plank_provider_windows SET allowance=$2,reserved=$3,consumed=$4 WHERE provider_account='ordiscan:default' AND window_key='day' AND window_started_at=$1`, [window.startsAt,original.allowance,original.reserved,original.consumed]);
    else await postgresQuery("DELETE FROM plank_provider_windows WHERE provider_account='ordiscan:default' AND window_key='day' AND window_started_at=$1", [window.startsAt]);
    await closePostgres();
  }
});
