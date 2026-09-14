import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { hasPostgresConfig, postgresQuery, closePostgres } from "../../lib/postgres";
import { durableKv } from "../../lib/market/durable-kv";
import {
  activityCoverageIsStale,
  activityCoverageKey,
  computeAndStoreActivityCoverage,
  readActivityCoverage,
  requestActivityCoverage,
  ACTIVITY_COVERAGE_SOURCE,
} from "../../lib/market/multichain/activity-coverage";

const SKIP = { skip: !hasPostgresConfig() };
const LEDGER_SRC = readFileSync("lib/market/multichain/ledger-activity.ts", "utf8");
const LANE_SRC = readFileSync("scripts/mesh-lane.ts", "utf8");

test("staleness is decided by evidence: a newer feed event, never a timer", () => {
  const counted = { indexedEvents: 10, timestampedEvents: 10, oldestTimestamp: "2026-01-01T00:00:00.000Z", newestTimestamp: "2026-09-14T10:00:00.000Z", byVenue: {}, countedAt: "2026-09-14T10:00:05.000Z" };
  assert.equal(activityCoverageIsStale(null, new Date("2026-09-14T10:00:00.000Z")), true, "no count is stale");
  assert.equal(activityCoverageIsStale(counted, new Date("2026-09-14T10:00:00.000Z")), false, "same newest: current, however old the count");
  assert.equal(activityCoverageIsStale(counted, new Date("2026-09-14T09:00:00.000Z")), false, "older feed cannot prove new rows");
  assert.equal(activityCoverageIsStale(counted, new Date("2026-09-14T10:00:01.000Z")), true, "one newer event: recount");
  assert.equal(activityCoverageIsStale(counted, null), false, "an untimestamped page proves nothing newer");
  assert.equal(activityCoverageIsStale({ ...counted, newestTimestamp: null }, new Date()), true, "a count with no newest cannot be shown current against a timestamped page");
});

test("the request path never counts: readLedgerActivity issues exactly one postgresQuery and reads the count from the KV", () => {
  const start = LEDGER_SRC.indexOf("export async function readLedgerActivity");
  assert.ok(start >= 0);
  const rest = LEDGER_SRC.slice(start + 1);
  const next = rest.search(/\nexport /);
  const fn = next >= 0 ? LEDGER_SRC.slice(start, start + 1 + next) : LEDGER_SRC.slice(start);
  assert.equal([...fn.matchAll(/postgresQuery</g)].length, 1, "one query: the bounded feed");
  assert.doesNotMatch(fn, /COUNT\(\*\)/, "no COUNT on the request path");
  assert.doesNotMatch(fn, /\$\{UNION_SQL\}/, "the unbounded union is never read here");
  assert.match(fn, /readActivityCoverage\(/, "the count is read from the KV");
  assert.match(fn, /activityCoverageIsStale\(/, "and judged against the feed's newest event");
  assert.match(fn, /void requestActivityCoverage\(/, "a recount is requested without awaiting it");
});

test("the mesh lane runs the count under the worker's budget", () => {
  assert.match(LANE_SRC, /source === "activity-coverage"/);
  assert.match(LANE_SRC, /computeAndStoreActivityCoverage\(chain, subject\)/);
  assert.equal(ACTIVITY_COVERAGE_SOURCE, "activity-coverage");
});

test("the worker counts the whole union, stores it, and the route-side reader returns exactly that", SKIP, async () => {
  const chain = "eth-mainnet";
  const contract = `0xzztest${Date.now().toString(16)}`.padEnd(42, "0").slice(0, 42);
  try {
    const counted = await computeAndStoreActivityCoverage(chain, contract);
    assert.equal(counted.indexedEvents, 0, "an unknown collection counts to zero, honestly");
    assert.equal(counted.newestTimestamp, null);
    const read = await readActivityCoverage(chain, contract);
    assert.deepEqual(read, counted);
    // A lower-cased key: the route and the worker agree whatever the caller's casing.
    assert.equal(activityCoverageKey(chain, contract.toUpperCase()), activityCoverageKey(chain, contract));
  } finally {
    await postgresQuery(`DELETE FROM plank_kv_values WHERE key_name=$1`, [activityCoverageKey(chain, contract)]);
  }
});

test("a recount request is one deduplicated subject job on the collection's chain lane", SKIP, async () => {
  const chain = "eth-mainnet";
  const contract = `0xzztest${Date.now().toString(16)}`.padEnd(42, "0").slice(0, 42);
  const jobKey = `${ACTIVITY_COVERAGE_SOURCE}:${chain}:${contract}`;
  try {
    await requestActivityCoverage(chain, contract.toUpperCase());
    await requestActivityCoverage(chain, contract);
    const jobs = await postgresQuery<{ kind: string; source: string; subject: string; n: string }>(
      `SELECT kind, source, subject, COUNT(*)::text AS n FROM plank_data_jobs WHERE job_key=$1 GROUP BY 1,2,3`, [jobKey]);
    assert.equal(jobs.rows.length, 1, "two requests, one job");
    assert.equal(jobs.rows[0].n, "1");
    assert.equal(jobs.rows[0].kind, `mesh-lane:${chain}`);
    assert.equal(jobs.rows[0].source, ACTIVITY_COVERAGE_SOURCE);
    assert.equal(jobs.rows[0].subject, contract);
  } finally {
    await postgresQuery(`DELETE FROM plank_data_jobs WHERE job_key=$1`, [jobKey]);
    await durableKv.set(activityCoverageKey(chain, contract), null).catch(() => undefined);
    await postgresQuery(`DELETE FROM plank_kv_values WHERE key_name=$1`, [activityCoverageKey(chain, contract)]);
  }
});

after(closePostgres);
