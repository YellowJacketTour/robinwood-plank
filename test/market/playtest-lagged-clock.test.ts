import assert from "node:assert/strict";
import test from "node:test";
import {
  clampDisplayLagMs, DEFAULT_DISPLAY_LAG_MS, deriveLaggedRoundClock, deriveRoundClock,
  laggedLockGrantBps, MAX_DISPLAY_LAG_MS, MIN_DISPLAY_LAG_MS, multiplierBpsAtMs,
  type RoundClockInput,
} from "../../lib/playtest-live-shared";

const T = 1_700_000_000_000;
const DELTA = 1_000;

const running = (serverNowMs: number, crashAtMs: number | null = null): RoundClockInput => ({
  phase: "running", startedAtMs: T, crashAtMs, settledAtMs: null, nextLaunchAtMs: null, serverNowMs,
});

test("the published display lag is clamped into [600, 2000]ms and the default is inside it", () => {
  assert.equal(MIN_DISPLAY_LAG_MS, 600);
  assert.equal(MAX_DISPLAY_LAG_MS, 2_000);
  assert.equal(clampDisplayLagMs(100), 600);
  assert.equal(clampDisplayLagMs(599), 600);
  assert.equal(clampDisplayLagMs(600), 600);
  assert.equal(clampDisplayLagMs(1_234), 1_234);
  assert.equal(clampDisplayLagMs(2_000), 2_000);
  assert.equal(clampDisplayLagMs(50_000), 2_000);
  assert.equal(clampDisplayLagMs(Number.NaN), DEFAULT_DISPLAY_LAG_MS);
  assert.equal(clampDisplayLagMs(undefined), DEFAULT_DISPLAY_LAG_MS);
  assert.ok(DEFAULT_DISPLAY_LAG_MS >= 600 && DEFAULT_DISPLAY_LAG_MS <= 2_000);
});

test("countdown semantics are UNCHANGED by the presentation lag (T=0 stays the authoritative launch)", () => {
  for (const dt of [1, 250, 999, 1_000, 1_001, 5_000]) {
    assert.deepEqual(
      deriveLaggedRoundClock(running(T - dt), DELTA),
      deriveRoundClock(running(T - dt)),
      `T-${dt}ms countdown identical to the un-lagged clock`,
    );
  }
});

test("ignition hold: burning on the pad for [T, T+delta), liftoff renders exactly at T+delta", () => {
  // T..T+delta-1: ignition (position == pad anchor; multiplier readout 1.00x).
  for (const dt of [0, 1, 500, DELTA - 1]) {
    const view = deriveLaggedRoundClock(running(T + dt), DELTA);
    assert.equal(view.kind, "ignition", `T+${dt}ms is the ignition hold`);
    assert.ok(view.kind === "ignition" && view.sinceIgnitionMs === dt);
    assert.ok(view.kind === "ignition" && view.holdRemainingMs === DELTA - dt);
  }
  // T+delta: the first rendered flight millisecond is flightMs=0, exactly 1.00x.
  assert.deepEqual(deriveLaggedRoundClock(running(T + DELTA), DELTA),
    { kind: "flight", flightMs: 0, bps: 10_000 });
  assert.deepEqual(deriveLaggedRoundClock(running(T + DELTA + 1), DELTA),
    { kind: "flight", flightMs: 1, bps: multiplierBpsAtMs(1) });
});

test("the lagged display is never ahead of authoritative-minus-delta, and is monotone", () => {
  let lastFlight = -1;
  let lastBps = 0;
  for (let dt = -2_000; dt <= 12_000; dt += 7) {
    const view = deriveLaggedRoundClock(running(T + dt), DELTA);
    if (view.kind !== "flight") continue;
    assert.equal(view.flightMs, dt - DELTA, "display time = server time - delta exactly");
    assert.equal(view.bps, multiplierBpsAtMs(dt - DELTA), "display multiplier obeys the ONE shared law");
    assert.ok(view.bps <= multiplierBpsAtMs(dt), "never ahead of the authoritative multiplier");
    assert.ok(view.flightMs > lastFlight && view.bps >= lastBps, "monotone, no dip");
    lastFlight = view.flightMs; lastBps = view.bps;
  }
});

test("the crash renders exactly delta late and the lagged replay survives the settled phase flip", () => {
  const crashAt = T + 6_000;
  // Still flying (in the lagged timeline) right up to crashAt+delta.
  const justBefore = deriveLaggedRoundClock(running(crashAt + DELTA - 1, crashAt), DELTA);
  assert.equal(justBefore.kind, "flight");
  assert.ok(justBefore.kind === "flight" && justBefore.bps <= multiplierBpsAtMs(6_000));
  // Crash renders at crashAt+delta with the true crash flight time.
  assert.deepEqual(deriveLaggedRoundClock(running(crashAt + DELTA, crashAt), DELTA),
    { kind: "crashed", flightMs: 6_000 });
  // Server settlement proceeds on authoritative time: phase can already be
  // "settled" while the lagged display is still replaying the flight.
  const settled = (serverNowMs: number): RoundClockInput => ({
    phase: "settled", startedAtMs: T, crashAtMs: crashAt, settledAtMs: crashAt + 40,
    nextLaunchAtMs: crashAt + 40 + 30_000, serverNowMs,
  });
  const midReplay = deriveLaggedRoundClock(settled(crashAt + 100), DELTA);
  assert.equal(midReplay.kind, "flight", "settled phase does not jump the display past the lagged flight");
  const laggedCrash = deriveLaggedRoundClock(settled(crashAt + DELTA), DELTA);
  assert.deepEqual(laggedCrash, { kind: "crashed", flightMs: 6_000 });
  // Only after the lagged crash has rendered may intermission take over.
  const after = deriveLaggedRoundClock(settled(crashAt + DELTA + 1_500), DELTA);
  assert.equal(after.kind, "intermission");
});

test("honest lock grant: exactly m(arrival - delta) bps against the shared law, null before liftoff", () => {
  // t_arrival - delta < launch: the honest lagged display was still pre-launch.
  assert.equal(laggedLockGrantBps(T, T - 1, DELTA), null);
  assert.equal(laggedLockGrantBps(T, T, DELTA), null, "arrival at T: display showed the pad, not a flight");
  assert.equal(laggedLockGrantBps(T, T + DELTA - 1, DELTA), null, "still the ignition hold");
  // From T+delta on, the grant is bps-exact against the ONE shared law.
  assert.equal(laggedLockGrantBps(T, T + DELTA, DELTA), 10_000);
  for (const flightMs of [1, 43, 500, 1_843, 4_000, 9_999]) {
    assert.equal(
      laggedLockGrantBps(T, T + DELTA + flightMs, DELTA),
      multiplierBpsAtMs(flightMs),
      `grant at arrival T+delta+${flightMs}ms is exactly m(${flightMs}ms)`,
    );
  }
  // The grant law clamps an out-of-range published delta too.
  assert.equal(laggedLockGrantBps(T, T + 700, 100), multiplierBpsAtMs(100), "delta below 600 clamps to 600");
  assert.equal(laggedLockGrantBps(T, T + 2_500, 99_999), multiplierBpsAtMs(500), "delta above 2000 clamps to 2000");
});
