import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_GROWTH_PER_SECOND } from "../../lib/playtest-live-shared";
import { PRIVATE_LIVE_GROWTH_PER_SECOND, PrivateLiveClock, privateCurveDurationSeconds } from "../../public/arcade/private-live-clock.js";

const snapshot = (overrides: Partial<Parameters<PrivateLiveClock["synchronize"]>[0]> = {}) => ({
  roundKey: "room:7",
  version: "10",
  phase: "running",
  startedAt: "2026-08-30T00:00:00.000Z",
  crashAt: "2026-08-30T00:00:10.000Z",
  serverNow: "2026-08-30T00:00:01.000Z",
  ...overrides,
});

test("browser and authoritative server use the exact same growth constant", () => {
  assert.equal(PRIVATE_LIVE_GROWTH_PER_SECOND, LIVE_GROWTH_PER_SECOND);
});

test("private live clock follows the authoritative exponential curve smoothly", () => {
  const clock = new PrivateLiveClock();
  assert.equal(clock.synchronize(snapshot(), 5_000), true);
  assert.equal(clock.sample(5_000), 12_460);
  assert.equal(clock.sample(5_016), 12_504);
  assert.equal(clock.sample(5_032), 12_548);
});

test("graph duration is derived from its endpoint so reconciliation cannot create a terminal spike", () => {
  const endpointBps = 17_800;
  const duration = privateCurveDurationSeconds(endpointBps);
  assert.ok(duration > 0);
  assert.ok(Math.abs(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * duration) - endpointBps) < 1e-8);
  const penultimate = 10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * duration * (23 / 24));
  assert.ok(penultimate > 17_300, "the penultimate point must approach the endpoint smoothly");
});

test("delayed and out-of-order snapshots can never rewind the multiplier", () => {
  const clock = new PrivateLiveClock();
  clock.synchronize(snapshot(), 5_000);
  const before = clock.sample(7_000);
  assert.equal(clock.synchronize(snapshot({ version: "9", serverNow: "2026-08-30T00:00:00.500Z" }), 7_010), false);
  assert.ok(clock.sample(7_010) >= before);
  clock.synchronize(snapshot({ version: "11", serverNow: "2026-08-30T00:00:02.500Z" }), 7_020);
  assert.ok(clock.sample(7_020) >= before);
});

test("polling does not restart ignition and the crash deadline caps flight", () => {
  const clock = new PrivateLiveClock();
  clock.synchronize(snapshot(), 5_000);
  const originalStart = (clock as unknown as { startedPerfMs: number }).startedPerfMs;
  clock.synchronize(snapshot({ version: "11", serverNow: "2026-08-30T00:00:01.250Z" }), 5_250);
  assert.equal((clock as unknown as { startedPerfMs: number }).startedPerfMs, originalStart);
  assert.equal(clock.sample(20_000), Math.floor(10_000 * Math.exp(0.22 * 10)));
});

test("a new round resets the monotonic floor", () => {
  const clock = new PrivateLiveClock();
  clock.synchronize(snapshot(), 5_000);
  assert.ok(clock.sample(8_000) > 10_000);
  clock.synchronize(snapshot({ roundKey: "room:8", version: "1", serverNow: "2026-08-30T00:00:00.000Z" }), 9_000);
  assert.equal(clock.sample(9_000), 10_000);
});

// ── δ-lagged presentation (2026-09-02) ───────────────────────────────────

test("ignition hold: with a published displayLagMs the rocket burns on the pad at exactly 1.00x for δ, then lifts", () => {
  const clock = new PrivateLiveClock();
  // Snapshot arrives exactly at the authoritative launch instant (serverNow == startedAt).
  assert.equal(clock.synchronize(snapshot({ crashAt: null, serverNow: "2026-08-30T00:00:00.000Z", displayLagMs: 1_000 }), 5_000), true);
  // Altitude source (bps) holds exactly 10_000 through [T, T+δ): pad anchor, no dip.
  for (const dt of [0, 1, 500, 999]) {
    assert.equal(clock.sample(5_000 + dt), 10_000, `display holds 1.00x at T+${dt}ms`);
  }
  // Liftoff at T+δ; from then on the display runs the true curve δ late.
  assert.ok(clock.sample(5_000 + 1_001) > 10_000, "liftoff strictly after the hold");
  const laggedAtTwoSeconds = clock.sample(5_000 + 2_000);
  assert.equal(laggedAtTwoSeconds, Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * 1)), "display shows m(t − δ)");
});

test("the crash renders δ late: the display deadline is the authoritative crash + δ, monotone to the exact crash bps", () => {
  const clock = new PrivateLiveClock();
  // 10s flight, δ=1000: crash must RENDER at perf T+11_000, at the true crash multiplier.
  clock.synchronize(snapshot({ serverNow: "2026-08-30T00:00:00.000Z", displayLagMs: 1_000 }), 5_000);
  const crashBps = Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * 10));
  assert.ok(clock.sample(5_000 + 10_500) < crashBps, "still below the crash while the raw feed has already crashed");
  assert.equal(clock.sample(5_000 + 11_000), crashBps, "lagged crash lands exactly on the committed crash multiplier");
  assert.equal(clock.sample(5_000 + 20_000), crashBps, "frozen at the crash after the lagged deadline");
});

test("a settled snapshot still anchors the lagged replay (crashAt is only published at settlement)", () => {
  const clock = new PrivateLiveClock();
  // Client saw the flight without crashAt (it is hidden while live) …
  clock.synchronize(snapshot({ crashAt: null, serverNow: "2026-08-30T00:00:04.000Z", displayLagMs: 1_000 }), 9_000);
  // … then the settled snapshot arrives ON authoritative time, mid-replay.
  clock.synchronize(snapshot({ phase: "settled", version: "11", serverNow: "2026-08-30T00:00:10.050Z", displayLagMs: 1_000 }), 15_050);
  assert.ok(clock.deadlinePerfMs !== null, "settlement establishes the lagged display deadline");
  const crashBps = Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * 10));
  assert.ok(clock.sample(15_100) < crashBps, "the lagged tail is still replaying after the room settled");
  assert.equal(clock.sample(16_200), crashBps, "and terminates exactly at the committed crash bps");
});

test("a pre-roll snapshot (serverNow before startedAt) anchors the display start in the FUTURE, never early", () => {
  const clock = new PrivateLiveClock();
  // Snapshot arrives 1.5s before the authoritative launch instant.
  clock.synchronize(snapshot({ crashAt: null, serverNow: "2026-08-29T23:59:58.500Z", displayLagMs: 1_000 }), 5_000);
  // Authoritative T is at perf 6_500; the lagged liftoff is at perf 7_500.
  for (const perf of [5_000, 6_499, 6_500, 7_400]) {
    assert.equal(clock.sample(perf), 10_000, `pad anchor holds at perf ${perf}`);
  }
  assert.ok(clock.sample(7_600) > 10_000, "liftoff only after T + δ");
  assert.equal(clock.sample(8_500), Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * 1)), "then exactly m(t − δ)");
});
