import assert from "node:assert/strict";
import test from "node:test";
import { ServerClockSync as AuthoritativeServerClockSync } from "../../lib/playtest-live-shared";
import { ServerClockSync } from "../../public/arcade/private-server-clock.js";

// public/arcade/private-server-clock.js is a browser-module port of
// lib/playtest-live-shared.ts's ServerClockSync (crash.html is a plain
// <script type="module"> with no bundler and cannot import a .ts file
// directly). These tests mirror playtest-round-clock.test.ts's own
// ServerClockSync coverage exactly, run against the PORT, to prove it is
// behaviorally identical to the tested authoritative source -- not just a
// similar-looking reimplementation.

test("the arcade port and the authoritative ServerClockSync are the same class shape", () => {
  const authoritative = new AuthoritativeServerClockSync();
  const port = new ServerClockSync();
  assert.equal(typeof port.observe, typeof authoritative.observe);
  assert.equal(typeof port.now, typeof authoritative.now);
  assert.equal(port.synchronized, authoritative.synchronized);
});

test("port: no estimate before the first observation", () => {
  const sync = new ServerClockSync();
  assert.equal(sync.now(0), null);
  assert.equal(sync.synchronized, false);
});

test("port: is monotonic, RTT-compensated, and wall-clock independent", () => {
  const sync = new ServerClockSync();
  // Server responds at serverNow=1000_000; request took 100ms round trip.
  sync.observe(1_000_000, 1_000, 1_100);
  assert.equal(sync.synchronized, true);
  // Midpoint compensation: at perf=1_100 the server is ~1_000_050.
  assert.equal(sync.now(1_100), 1_000_050);
  assert.equal(sync.now(1_600), 1_000_550, "advances with monotonic time only");
  // A later observation with a WORSE bound (long poll held 20s) is ignored --
  // this is the exact scenario the intermission's static-version long poll
  // produces, and exactly what the naive Date.now()-based offset could not
  // handle.
  sync.observe(999_000, 2_000, 22_000);
  assert.equal(sync.now(22_000), 1_020_950, "loose observation cannot rewind the clock");
  // A tighter fresh observation re-anchors, but the estimate never rewinds.
  const before = sync.now(30_000)!;
  sync.observe(1_028_000, 29_990, 30_010);
  const after = sync.now(30_010)!;
  assert.ok(after >= before, "estimate is monotone across re-anchoring");
});

test("port: a repaint of the SAME stale observation cannot rewind or corrupt the estimate", () => {
  // This is the exact bug this port exists to fix: acknowledgePrivateSettlement
  // repaints the cached snapshot when the reveal card is dismissed, which used
  // to recompute a naive Date.now()-based offset from the SAME stale
  // serverNow, corrupting the intermission countdown by however long the
  // reveal sat open. observe() called again with the identical serverNow/
  // sentPerfMs/receivedPerfMs triple must be a no-op against a fresher anchor.
  const sync = new ServerClockSync();
  sync.observe(1_000_000, 1_000, 1_100); // real network round trip
  const realEstimateLater = sync.now(28_100); // 27s of real elapsed perf time later
  // A "repaint" re-observes the SAME stale data (no new network round trip
  // occurred) -- this must not move the anchor, since its error bound (still
  // rtt/2 = 50) is not strictly tighter than the already-accepted anchor.
  sync.observe(1_000_000, 1_000, 1_100);
  const afterStaleRepaint = sync.now(28_100);
  assert.equal(afterStaleRepaint, realEstimateLater, "repainting the same stale observation must not move the clock");
});

test("port: refresh/reconnect resync converges on the server clock despite local wall-clock error", () => {
  const sync = new ServerClockSync();
  const serverStart = 5_000_000;
  sync.observe(serverStart, 10_000, 10_040);
  const est = sync.now(10_040)!;
  assert.ok(Math.abs(est - (serverStart + 20)) <= 20, "estimate within rtt/2 of server truth");
  assert.ok(Math.abs(sync.now(40_040)! - (serverStart + 20 + 30_000)) <= 20);
});

test("REPORTED BUG, end to end: leaving the reveal open 27s then dismissing it shows ~3s remaining, never a reset toward ~30s", () => {
  // Reproduces the exact reported scenario against the real fix's call
  // pattern: a real fetch anchors the clock at round settlement (T0), the
  // real launch is fixed at T0+30s, and the player leaves the reveal open for
  // 27 real seconds before dismissing it. In the OLD, buggy code,
  // acknowledgePrivateSettlement's repaint of the cached snapshot would
  // recompute Date.now() + (Date.parse(staleServerNow) - Date.now()) fresh,
  // re-anchoring "now" back to the settlement instant and showing ~30s
  // remaining again. The fix (paintPrivateSnapshot(snapshot, sentPerfMs =
  // null) only observing when sentPerfMs is a REAL send timestamp) means a
  // dismiss-repaint simply does not call observe() at all, so the estimate
  // reflects the true 27s of elapsed monotonic time.
  const sync = new ServerClockSync();
  const T0 = 1_000_000;
  const nextLaunchAtMs = T0 + 30_000;
  const remainingSecondsAt = (perfNowMs: number) => Math.ceil(Math.max(0, nextLaunchAtMs - (sync.now(perfNowMs) ?? 0)) / 1000);

  // The real long-poll fetch that delivered the settlement snapshot.
  sync.observe(T0, 0, 40);
  assert.equal(remainingSecondsAt(40), 30, "correct at settlement");

  // 27 REAL seconds pass while the reveal sits open. No further observe()
  // call happens here (that is the fix) -- the estimate must simply reflect
  // real elapsed monotonic time, not reset.
  assert.equal(remainingSecondsAt(27_040), 3, "shows the TRUE ~3s remaining, not a reset toward ~30s");
});
