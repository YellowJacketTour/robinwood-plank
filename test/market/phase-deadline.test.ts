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

/**
 * The wedge that blocked its own fix.
 *
 * Measured live 2026-09-09: pid 3246054, uptime 1,134s, `ticks 0`. It held the
 * `flock -n` that cron uses to decide whether to start a new process, so the
 * deploy that would have fixed it sat unused on disk for the full
 * --max-seconds budget. The breakage was holding the door.
 */

test("ticks are serial: a slow tick delays the next, never runs beside it", () => {
  // setInterval(tick, TICK_MS) fired regardless of whether the previous tick
  // had finished, so slow ticks piled up CONCURRENTLY onto the same throttled
  // hosts, each making the others slower.
  assert.ok(
    !/setInterval\(\(\) => void tick\(\), TICK_MS\)/.test(RUNNER),
    "the fixed-interval tick must be gone",
  );
  assert.match(RUNNER, /if \(!ticking\)/, "a tick in flight must suppress the next");
  assert.match(RUNNER, /setTimeout\(\(\) => void loop\(\), TICK_MS\)/, "the next tick is scheduled after this one ENDS");
});

test("a watchdog releases the lock rather than holding it for an hour", () => {
  assert.match(RUNNER, /WATCHDOG_MS/, "the watchdog must be a named constant");
  const m = RUNNER.match(/WATCHDOG_MS = Math\.max\((\d+_?\d*), TICK_MS \* (\d+)\)/);
  assert.ok(m, "the watchdog must be derived from the tick, not a magic number");
  const floor = Number(m![1].replace(/_/g, ""));
  assert.ok(floor >= 60_000, `a ${floor}ms watchdog would kill healthy slow work`);
  // The whole point is being far below --max-seconds=3540.
  assert.ok(floor <= 600_000, "a watchdog near the cron hour is not a watchdog");
});

test("THE WATCHDOG COMPARISON IS IN THE SAME UNITS", () => {
  // A mutation that changed `stalled < WATCHDOG_MS` to
  // `stalled < WATCHDOG_MS * 1000` ESCAPED the assertions above: they checked
  // that the constant existed and was sane, never that it was compared
  // correctly. A watchdog scaled by 1000 never fires and looks identical to
  // one that works -- the same "guard that cannot fire" shape this codebase
  // keeps hitting.
  const at = RUNNER.indexOf("const stalled = Date.now() - lastTickDone;");
  assert.ok(at > 0, "the watchdog must measure elapsed time since the last tick");
  const body = RUNNER.slice(at, at + 260);
  assert.match(
    body,
    /if \(stalled < WATCHDOG_MS\) return;/,
    "the comparison must be against WATCHDOG_MS directly, in milliseconds, unscaled",
  );
});

/** The watchdog decision as a pure predicate, so the boundary is exercised. */
function watchdogFires(msSinceLastTick: number, watchdogMs: number): boolean {
  return msSinceLastTick >= watchdogMs;
}

test("THE GUARD FIRES: the measured 1,134s wedge trips it", () => {
  const W = Math.max(180_000, 15_000 * 12); // 180s
  assert.equal(watchdogFires(1_134_000, W), true, "the real wedge must trip it");
  assert.equal(watchdogFires(45_000, W), false, "a slow but live worker must not");
  assert.equal(watchdogFires(W, W), true, "exactly at the deadline fires");
  assert.equal(watchdogFires(W - 1, W), false, "one millisecond under does not");
  // And the scaled-by-1000 mutation must be visibly useless.
  assert.equal(watchdogFires(1_134_000, W * 1000), false, "a x1000 watchdog never fires");
});

test("the watchdog EXITS rather than trying a graceful shutdown", () => {
  // shutdown() flushes, and a flush needing the same wedged resource would
  // hang the exit too -- a watchdog that can itself hang is not one.
  const at = RUNNER.indexOf("WATCHDOG_MS");
  const body = RUNNER.slice(at, at + 1200);
  assert.match(body, /process\.exit\(75\)/, "must exit hard, with EX_TEMPFAIL");
  assert.ok(!/shutdown\("watchdog"\)/.test(body), "must not attempt a flush that can hang");
});
