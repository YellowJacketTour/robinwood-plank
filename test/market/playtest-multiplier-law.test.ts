import assert from "node:assert/strict";
import test from "node:test";
import {
  flightViewport, LIVE_GROWTH_PER_SECOND, msToReachMultiplierBps,
  multiplierBpsAtMs, sampleFlightPath,
} from "../../lib/playtest-live-shared";
import { crashDurationMs, multiplierAt } from "../../lib/playtest-room-core";

test("M(t) starts exactly at 1.00x, is monotone and continuous on a dense grid", () => {
  assert.equal(multiplierBpsAtMs(0), 10_000);
  assert.equal(multiplierBpsAtMs(-500), 10_000, "pre-launch clamps to launch");
  let prior = multiplierBpsAtMs(0);
  for (let tMs = 1; tMs <= 60_000; tMs += 1) {
    const bps = multiplierBpsAtMs(tMs);
    assert.ok(bps >= prior, `monotone at ${tMs}ms`);
    // Continuity: at k=0.22/s a 1ms step multiplies by e^0.00022, so even at
    // 500,000 bps the integer step stays ~110 bps. A vertical spike would be
    // orders of magnitude larger.
    assert.ok(bps - prior <= Math.max(2, Math.ceil(prior * Math.expm1(LIVE_GROWTH_PER_SECOND / 1_000)) + 1),
      `no discontinuity at ${tMs}ms: ${prior} -> ${bps}`);
    prior = bps;
  }
});

test("inverse round-trips with the law across a dense multiplier grid", () => {
  for (let bps = 10_000; bps <= 120_000; bps += 37) {
    const ms = msToReachMultiplierBps(bps);
    assert.ok(multiplierBpsAtMs(ms) >= bps, `reached at ${bps}`);
    if (ms > 0) assert.ok(multiplierBpsAtMs(ms - 1) < bps, `first ms at ${bps}`);
  }
  assert.equal(msToReachMultiplierBps(10_000), 0);
  assert.equal(msToReachMultiplierBps(9_000), 0);
});

test("server settlement helpers delegate to the exact same shared law", () => {
  for (const tMs of [0, 1, 350, 1_000, 4_321, 12_500, 30_000]) {
    assert.equal(multiplierAt(1_000_000, 1_000_000 + tMs), BigInt(multiplierBpsAtMs(tMs)));
  }
  for (const crashBps of [10_100n, 15_000n, 20_000n, 38_000n, 100_000n]) {
    const duration = crashDurationMs(crashBps);
    assert.ok(duration >= 350);
    // At the crash deadline the authoritative multiplier equals (or has just
    // reached) the committed crash multiplier: truthful at crash/cap.
    assert.ok(multiplierAt(0, duration) >= crashBps);
  }
});

test("sampled flight path is origin-anchored, monotone, and endpoint-truthful", () => {
  for (const elapsedMs of [0, 1, 120, 999, 1_000, 5_000, 17_345]) {
    const path = sampleFlightPath(elapsedMs, 96);
    assert.deepEqual(path[0], { tMs: 0, bps: 10_000 }, "trace starts exactly at origin");
    const end = path[path.length - 1];
    assert.equal(end.tMs, Math.max(0, elapsedMs));
    assert.equal(end.bps, multiplierBpsAtMs(elapsedMs), "endpoint equals authoritative multiplier");
    for (let i = 1; i < path.length; i += 1) {
      assert.ok(path[i].tMs >= path[i - 1].tMs, "time monotone");
      assert.ok(path[i].bps >= path[i - 1].bps, "multiplier monotone");
      assert.ok(path[i].tMs <= Math.max(0, elapsedMs), "no phantom coordinate past the endpoint");
    }
  }
});

test("REGRESSION: no artificial vertical spike between adjacent plotted points", () => {
  // The old presentation normalized the trace to full-round axes and let a
  // phantom high coordinate join the endpoint, producing a flat line that
  // jumped vertically. With uniform time sampling of the true law, adjacent
  // points must always advance in BOTH axes proportionally: a vertical
  // segment (dt == 0 with dbps > 0) can never exist, and no single segment
  // may carry more than a small bounded share of the total rise.
  const path = sampleFlightPath(20_000, 96);
  const totalRise = path[path.length - 1].bps - path[0].bps;
  for (let i = 1; i < path.length; i += 1) {
    const dt = path[i].tMs - path[i - 1].tMs;
    const dbps = path[i].bps - path[i - 1].bps;
    if (dbps > 0) assert.ok(dt > 0, "a rising segment must consume time (no vertical spike)");
    assert.ok(dbps <= totalRise * 0.08, `segment ${i} carries ${dbps}/${totalRise} of the rise`);
  }
});

test("viewport scales to the LIVE multiplier, never to full-round axes", () => {
  // Early flight: 1.05x after ~0.5s must be legible, i.e. the y-axis tops out
  // near the live value, not at a 38x crash multiplier.
  const early = flightViewport(500, multiplierBpsAtMs(500));
  assert.ok(early.bpsMax <= 16_000, `early viewport is tight: ${early.bpsMax}`);
  assert.ok(early.bpsMax > multiplierBpsAtMs(500), "endpoint fits inside the viewport");
  assert.equal(early.ticksBps[0], 10_000, "first labeled tick is 1.00x");
  // Later the viewport follows the live value with bounded headroom.
  const late = flightViewport(15_000, multiplierBpsAtMs(15_000));
  assert.ok(late.bpsMax >= multiplierBpsAtMs(15_000));
  assert.ok(late.bpsMax <= multiplierBpsAtMs(15_000) * 1.16);
  assert.ok(late.tMaxMs >= 15_000, "the time horizon always contains the elapsed flight");
  // Ticks ascend and stay within the viewport.
  for (let i = 1; i < late.ticksBps.length; i += 1) assert.ok(late.ticksBps[i] > late.ticksBps[i - 1]);
  assert.ok(late.ticksBps[late.ticksBps.length - 1] <= late.bpsMax + 1);
});
