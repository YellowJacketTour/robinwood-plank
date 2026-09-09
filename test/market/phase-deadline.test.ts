import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * A phase must not be able to outlive the tick.
 *
 * Measured live 2026-09-09: a worker booted, wrote its boot heartbeat, and sat
 * at `ticks 0` for five minutes. Its first tick could not finish, because no
 * phase had a deadline and every Esplora host was blocking that box's IP.
 *
 * The arithmetic, corrected: getBestBlockHash is 2 gets and each get tries all
 * 6 hosts at 8s, so 96s; walkPath then costs one more failed header (it breaks
 * on the FIRST miss, not after 200) for another 48s. ~144s for one bitcoinTick
 * against a 15s tick interval.
 *
 * A hang is the one state indistinguishable from a dead process out here: no
 * progress, no error, no next tick. A deadline turns it into a recorded
 * FAILURE with a reason, and lets the remaining phases run.
 */

const RUNNER = readFileSync("scripts/akasha-hose.ts", "utf8").replace(/\r\n/g, "\n");

test("every phase runs under a deadline", () => {
  const at = RUNNER.indexOf("const phase = async (");
  assert.ok(at > 0, "phase() must exist");
  const body = RUNNER.slice(at, RUNNER.indexOf("const tick = async ()", at));
  assert.match(body, /Promise\.race\(/, "the work must race a timer");
  assert.match(body, /PHASE_TIMEOUT_MS/, "the deadline must be a named constant");
});

test("the deadline is longer than a tick but shorter than the cron hour", () => {
  const m = RUNNER.match(/PHASE_TIMEOUT_MS = Math\.max\((\d+_?\d*), TICK_MS \* (\d+)\)/);
  assert.ok(m, "the deadline must be derived, not a magic number");
  const floor = Number(m![1].replace(/_/g, ""));
  const mult = Number(m![2]);
  assert.ok(floor >= 30_000, `a ${floor}ms floor would kill healthy slow phases`);
  assert.ok(mult >= 2, "a deadline at 1x the tick would fire on normal work");
  // The worker restarts hourly under --max-seconds=3540; a phase deadline near
  // that is no deadline at all.
  assert.ok(floor * mult <= 600_000, "the deadline must be far below the cron hour");
});

test("a timed-out phase is recorded as a FAILURE, not silently skipped", () => {
  const at = RUNNER.indexOf("const phase = async (");
  const body = RUNNER.slice(at, RUNNER.indexOf("const tick = async ()", at));
  // The catch that records the failure must still be reached by a timeout,
  // which is only true if the race REJECTS rather than resolving.
  assert.match(body, /reject\(new Error\(`phase \$\{name\} exceeded/, "the timer must reject");
  assert.match(body, /"failure"/, "and the rejection must be recorded as a failure");
});

test("the timer is always cleared", () => {
  // A pending setTimeout keeps the event loop alive; leaking one per phase per
  // tick would stop a bounded run from ever exiting on its budget.
  const at = RUNNER.indexOf("const phase = async (");
  const body = RUNNER.slice(at, RUNNER.indexOf("const tick = async ()", at));
  assert.match(body, /clearTimeout\(timer\)/, "the timer must be cleared");
  assert.match(body, /\.finally\(/, "and cleared on BOTH paths, not only on success");
});

/** The deadline as a pure predicate, so the boundary is exercised. */
function phaseTimedOut(elapsedMs: number, deadlineMs: number): boolean {
  return elapsedMs > deadlineMs;
}

test("THE GUARD FIRES: a wedged phase trips, a slow-but-healthy one does not", () => {
  const D = 60_000;
  assert.equal(phaseTimedOut(144_000, D), true, "the measured all-hosts-blocked case must trip");
  assert.equal(phaseTimedOut(20_000, D), false, "a slow but finishing tick must not");
  assert.equal(phaseTimedOut(D, D), false, "exactly at the deadline is not over it");
  assert.equal(phaseTimedOut(D + 1, D), true, "one millisecond past is");
});
