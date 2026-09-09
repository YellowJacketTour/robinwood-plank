import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Bitcoin's backfill sat frozen at blocksToProtocolT0 = 198,651 across three
 * investigations. Every one produced a plausible root cause that was wrong,
 * because from outside the process these are INDISTINGUISHABLE:
 *
 *   1. the worker is not running
 *   2. it runs, but a phase before the backfill throws every tick
 *   3. it runs, the backfill executes, and cannot advance
 *
 * All three: frozen number, healthy site, no error on any HTTP surface. The
 * worker knew which one it was and said so on stdout, where no route can read.
 *
 * These tests defend the properties that make the three separable.
 */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const RUNNER = read("scripts/akasha-hose.ts");
const MAIN = read("packages/akasha/src/hose/main.ts");
const ROUTE = read("app/api/market/multichain/worker-health/route.ts");
const MIGRATION = read("deploy/inmotion/postgres/migrations/109_akasha_worker_telemetry.sql");
// The upsert arithmetic lives with the WRITE, not the DDL: the migration only
// creates the table. My first version of these tests asserted against the
// migration and failed while the code was correct.
const STORE = read("packages/akasha/src/hose/pg-store.ts");

test("a failing phase no longer takes the rest of the tick with it", () => {
  // THE ACTUAL BUG. bitcoin-tip, repair, shard and backfill shared ONE
  // try/catch, so a throw in an early phase silently skipped every later one
  // -- including the backfill -- for that tick, forever, while the process
  // stayed up and looked healthy.
  const at = RUNNER.indexOf("const tick = async ()");
  assert.ok(at > 0, "the tick must exist");
  const body = RUNNER.slice(at, RUNNER.indexOf("setInterval(() => void tick()", at));
  for (const name of ["bitcoin-tip", "repair", "backfill"]) {
    assert.ok(
      body.includes(`phase("${name}"`),
      `${name} must run inside its own phase() so a sibling's throw cannot skip it`,
    );
  }
});

test("phase() records the attempt BEFORE running, and the outcome after", () => {
  // Recording only on success cannot distinguish "never ran" from "ran and
  // threw" -- both leave no row. The attempt is the half that makes a hang
  // visible at all.
  const at = RUNNER.indexOf("const phase = async (");
  assert.ok(at > 0, "phase() must exist");
  const body = RUNNER.slice(at, RUNNER.indexOf("const tick = async ()", at));
  const attempt = body.indexOf('"attempt"');
  const run = body.indexOf("await run()");
  const success = body.indexOf('"success"');
  const failure = body.indexOf('"failure"');
  assert.ok(attempt > 0 && run > 0 && success > 0 && failure > 0, "all three outcomes must be recorded");
  assert.ok(attempt < run, "the attempt must be recorded BEFORE the work, or a hang is invisible");
  assert.ok(run < success, "success must be recorded after the work");
});

test("phase() swallows so one failure cannot abort the tick", () => {
  const at = RUNNER.indexOf("const phase = async (");
  const body = RUNNER.slice(at, RUNNER.indexOf("const tick = async ()", at));
  assert.match(body, /catch \(e\)/, "phase() must catch");
  assert.ok(!/throw e;/.test(body), "and must NOT rethrow, or it reintroduces the shared-failure bug");
});

test("backfillTick records its attempt before the early return", () => {
  // `if (!this.backfill) return undefined` is itself one of the ambiguous
  // states: a hose with no durable store reports exactly what a stalled one
  // reports -- nothing.
  const at = MAIN.indexOf("async backfillTick(");
  assert.ok(at > 0);
  const body = MAIN.slice(at, MAIN.indexOf("async bitcoinTick(", at));
  const attempt = body.indexOf('"backfill", "attempt"');
  // Anchor on the STATEMENT, not the phrase: the explanatory comment above
  // quotes `if (!this.backfill)` verbatim, so indexOf found the prose and
  // reported the attempt as coming after it -- failing while the code was
  // correct. Match the real branch by its indentation and body.
  const earlyReturn = body.indexOf("    if (!this.backfill) {");
  assert.ok(attempt > 0, "the attempt must be recorded");
  assert.ok(attempt < earlyReturn, "and recorded BEFORE the early return");
});

test("the backfill's own reason string is persisted, not discarded", () => {
  // step() already returns "epoch produced no header" / "tail is at
  // protocol_t0" / "epoch did not hash-link...". That sentence was thrown
  // away, which is why a frozen number had no explanation attached.
  const at = MAIN.indexOf("async backfillTick(");
  const body = MAIN.slice(at, MAIN.indexOf("async bitcoinTick(", at));
  assert.match(body, /reason: first\?\.reason/, "the reason must be recorded");
});

test("a throw inside step() is recorded and still propagates", () => {
  const at = MAIN.indexOf("async backfillTick(");
  const body = MAIN.slice(at, MAIN.indexOf("async bitcoinTick(", at));
  assert.match(body, /"backfill", "failure"/, "a throw must be recorded");
  assert.match(body, /throw e;/, "and must still propagate, so behaviour is unchanged");
});

test("counters accumulate rather than overwrite", () => {
  // A gauge that resets each tick cannot show a trend, and the trend is the
  // whole signal: attempts climbing while completions do not IS the diagnosis.
  assert.match(STORE, /attempts\s+= akasha_worker_phase\.attempts \+ EXCLUDED\.attempts/);
  assert.match(STORE, /completions = akasha_worker_phase\.completions \+ EXCLUDED\.completions/);
  assert.match(STORE, /failures\s+= akasha_worker_phase\.failures \+ EXCLUDED\.failures/);
});

test("a later attempt cannot erase the reason that explains the stall", () => {
  // Without COALESCE, the next tick's attempt row (which carries no reason)
  // would null out the error that explains everything.
  for (const field of ["last_reason", "last_error", "last_detail"]) {
    // Tolerate the SQL's column alignment (last_error has two spaces before
    // the `=`); assert the SEMANTICS, not the whitespace.
    assert.ok(
      STORE.includes(`COALESCE(EXCLUDED.${field}, akasha_worker_phase.${field})`),
      `${field} must be COALESCEd or it is erased by the next attempt`,
    );
  }
});

test("the endpoint reports a verdict, not just numbers", () => {
  // Numbers that still need interpreting are how this stayed unresolved.
  for (const v of [
    "no-heartbeat",
    "worker-stalled-or-dead",
    "backfill-never-attempted",
    "backfill-hangs",
    "backfill-throws",
    "backfill-runs-but-cannot-advance",
  ]) {
    assert.ok(ROUTE.includes(v), `the diagnosis must cover: ${v}`);
  }
  assert.match(ROUTE, /nextStep/, "and must say what to do about it");
});

test("the verdict checks a dead worker BEFORE the backfill's counters", () => {
  // A dead worker explains every downstream symptom, so checking backfill
  // counters first would produce a confident, wrong diagnosis -- exactly the
  // failure mode this endpoint exists to end.
  const dead = ROUTE.indexOf('verdict = "worker-stalled-or-dead"');
  const cannotAdvance = ROUTE.indexOf('verdict = "backfill-runs-but-cannot-advance"');
  assert.ok(dead > 0 && cannotAdvance > 0);
  assert.ok(dead < cannotAdvance, "liveness must be ruled out first");
});

test("a hang is expressible: attempts minus completions minus failures", () => {
  // A phase that starts and neither finishes nor throws is HANGING, which no
  // single counter can express.
  assert.match(ROUTE, /inFlightOrHung/, "the hang signal must be surfaced");
  assert.match(
    ROUTE,
    /Number\(p\.attempts\) - Number\(p\.completions\) - Number\(p\.failures\)/,
    "and must be computed from all three counters",
  );
});

test("the telemetry tables cannot become the next unbounded table", () => {
  // Migration 108 existed because an append-only table grew without limit.
  // These are one row per (chain, phase) and one per worker, by primary key.
  assert.match(MIGRATION, /PRIMARY KEY \(chain, phase\)/, "phases must collapse to one row each");
  assert.match(MIGRATION, /worker\s+TEXT PRIMARY KEY/, "heartbeat must be one row per worker");
  assert.ok(!/CREATE TABLE[\s\S]*id\s+BIGSERIAL/.test(MIGRATION), "no append-only growth");
});
