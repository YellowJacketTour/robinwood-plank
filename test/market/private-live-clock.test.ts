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
