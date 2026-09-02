import assert from "node:assert/strict";
import test from "node:test";
import {
  countdownDisplaySeconds, deriveRoundClock, multiplierBpsAtMs, ServerClockSync,
  type RoundClockInput,
} from "../../lib/playtest-live-shared";

const T = 1_700_000_000_000; // authoritative launch instant (server clock)

const running = (serverNowMs: number, crashAtMs: number | null = null): RoundClockInput => ({
  phase: "running", startedAtMs: T, crashAtMs, settledAtMs: null, nextLaunchAtMs: null, serverNowMs,
});

test("T-boundary semantics with a deterministic fake clock (integer ms)", () => {
  // T−1001ms: more than one full second remains -> displays 2.
  let view = deriveRoundClock(running(T - 1_001));
  assert.deepEqual(view, { kind: "countdown", remainingMs: 1_001, displaySeconds: 2 });
  // T−1000ms: exactly one second -> displays 1.
  view = deriveRoundClock(running(T - 1_000));
  assert.deepEqual(view, { kind: "countdown", remainingMs: 1_000, displaySeconds: 1 });
  // T−1ms: positive time remains -> STILL displays 1, never 0.
  view = deriveRoundClock(running(T - 1));
  assert.deepEqual(view, { kind: "countdown", remainingMs: 1, displaySeconds: 1 });
  // T: countdown is exhausted and flight starts at exactly 0 elapsed / 1.00x.
  view = deriveRoundClock(running(T));
  assert.deepEqual(view, { kind: "flight", flightMs: 0, bps: 10_000 });
  // T+1ms: one authoritative millisecond of flight.
  view = deriveRoundClock(running(T + 1));
  assert.deepEqual(view, { kind: "flight", flightMs: 1, bps: multiplierBpsAtMs(1) });
});

test("presentation never enters RUNNING before the authoritative launch instant", () => {
  // The room row flips to phase="running" during the server pre-roll while
  // startedAt is still in the future. The derived view must stay pre-launch
  // for EVERY millisecond before T.
  for (const dt of [1, 2, 250, 999, 1_000, 1_499, 5_000]) {
    const view = deriveRoundClock(running(T - dt));
    assert.equal(view.kind, "countdown", `T-${dt}ms is still a countdown`);
    assert.ok(view.kind === "countdown" && view.displaySeconds > 0,
      "positive remaining time never displays 0");
  }
});

test("countdown display and launch are mutually exclusive by construction", () => {
  for (let dt = -3_000; dt <= 3_000; dt += 1) {
    const view = deriveRoundClock(running(T + dt));
    if (view.kind === "countdown") {
      assert.ok(dt < 0, "a countdown can only exist before T");
      assert.ok(view.displaySeconds >= 1, "never shows 0 while time remains");
    } else {
      assert.ok(dt >= 0, "flight can only exist at or after T");
    }
  }
});

test("crash deadline is truthful: flight caps at the committed crash instant", () => {
  const crashAt = T + 6_000;
  const before = deriveRoundClock(running(crashAt - 1, crashAt));
  assert.equal(before.kind, "flight");
  const at = deriveRoundClock(running(crashAt, crashAt));
  assert.deepEqual(at, { kind: "crashed", flightMs: 6_000 });
  const after = deriveRoundClock(running(crashAt + 5_000, crashAt));
  assert.deepEqual(after, { kind: "crashed", flightMs: 6_000 }, "elapsed never runs past the crash");
});

test("intermission counts down to the scheduled automatic launch", () => {
  const settled = T + 10_000;
  const nextLaunch = settled + 30_000;
  const input = (serverNowMs: number): RoundClockInput => ({
    phase: "settled", startedAtMs: T, crashAtMs: T + 6_000, settledAtMs: settled,
    nextLaunchAtMs: nextLaunch, serverNowMs,
  });
  assert.deepEqual(deriveRoundClock(input(settled)), { kind: "intermission", remainingMs: 30_000, displaySeconds: 30 });
  assert.deepEqual(deriveRoundClock(input(nextLaunch - 1)), { kind: "intermission", remainingMs: 1, displaySeconds: 1 });
  assert.deepEqual(deriveRoundClock(input(nextLaunch)), { kind: "intermission", remainingMs: 0, displaySeconds: 0 });
});

test("ceil-seconds countdown never rounds positive time to zero", () => {
  assert.equal(countdownDisplaySeconds(1_001), 2);
  assert.equal(countdownDisplaySeconds(1_000), 1);
  assert.equal(countdownDisplaySeconds(1), 1);
  assert.equal(countdownDisplaySeconds(0), 0);
  assert.equal(countdownDisplaySeconds(-50), 0);
});

test("ServerClockSync is monotonic, RTT-compensated, and wall-clock independent", () => {
  const sync = new ServerClockSync();
  assert.equal(sync.now(0), null, "no estimate before the first observation");
  // Server responds at serverNow=1000_000; request took 100ms round trip.
  sync.observe(1_000_000, 1_000, 1_100);
  // Midpoint compensation: at perf=1_100 the server is ~1_000_050.
  assert.equal(sync.now(1_100), 1_000_050);
  assert.equal(sync.now(1_600), 1_000_550, "advances with monotonic time only");
  // A later observation with a WORSE bound (long poll held 20s) is ignored.
  sync.observe(999_000, 2_000, 22_000);
  assert.equal(sync.now(22_000), 1_020_950, "loose observation cannot rewind the clock");
  // A tighter fresh observation re-anchors, but the estimate never rewinds.
  const before = sync.now(30_000)!;
  sync.observe(1_028_000, 29_990, 30_010);
  const after = sync.now(30_010)!;
  assert.ok(after >= before, "estimate is monotone across re-anchoring");
});

test("refresh/reconnect resync converges on the server clock despite local wall-clock error", () => {
  const sync = new ServerClockSync();
  // The device wall clock is 90s wrong; only perf timestamps are used, so the
  // estimate reflects the SERVER axis exactly.
  const serverStart = 5_000_000;
  sync.observe(serverStart, 10_000, 10_040);
  const est = sync.now(10_040)!;
  assert.ok(Math.abs(est - (serverStart + 20)) <= 20, "estimate within rtt/2 of server truth");
  // 30 seconds later on the monotonic axis the estimate advanced 30 seconds.
  assert.ok(Math.abs(sync.now(40_040)! - (serverStart + 20 + 30_000)) <= 20);
});
