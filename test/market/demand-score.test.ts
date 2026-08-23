import assert from "node:assert/strict";
import test from "node:test";
import { computeDemandScore, type DemandScoreInput } from "../../lib/market/multichain/demand-score";

const EMPTY: DemandScoreInput = {
  volume24hWei: null, volume7dWei: null, volume30dWei: null,
  sales24h: null, sales7d: null, sales30d: null,
  listedCount: null, totalSupply: null, holderCount: null,
  rankedTokenCount: null, projectedTokenCount: null,
};

test("computeDemandScore is ungradable with zero real signals", () => {
  const result = computeDemandScore(EMPTY);
  assert.equal(result.gradable, false);
  assert.equal(result.score, 0);
  assert.deepEqual(result.parts, []);
});

test("computeDemandScore treats all-zero volume as flat, not a crash or negative score", () => {
  const result = computeDemandScore({
    ...EMPTY,
    volume24hWei: "0", volume7dWei: "0", volume30dWei: "0",
  });
  assert.equal(result.gradable, true);
  assert.ok(result.score >= 0);
  const momentumPart = result.parts.find((p) => p.label.startsWith("Volume"));
  assert.ok(momentumPart);
  assert.equal(momentumPart!.points, 0);
});

test("computeDemandScore rewards real accelerating volume above its own trailing baseline", () => {
  const flat = computeDemandScore({
    ...EMPTY,
    volume24hWei: String(10_000), volume7dWei: String(7 * 10_000), volume30dWei: String(30 * 10_000),
  });
  const accelerating = computeDemandScore({
    ...EMPTY,
    volume24hWei: String(50_000), volume7dWei: String(7 * 10_000), volume30dWei: String(30 * 10_000),
  });
  assert.ok(accelerating.score > flat.score, `expected accelerating (${accelerating.score}) > flat (${flat.score})`);
});

test("computeDemandScore treats a real declining trend as zero momentum, never negative", () => {
  const declining = computeDemandScore({
    ...EMPTY,
    volume24hWei: String(1_000), volume7dWei: String(7 * 10_000), volume30dWei: String(30 * 10_000),
  });
  const momentumPart = declining.parts.find((p) => p.label.startsWith("Volume"));
  assert.ok(momentumPart);
  assert.equal(momentumPart!.points, 0);
  assert.ok(declining.score >= 0);
});

test("computeDemandScore falls back to sales counts when $ volume windows are missing", () => {
  const result = computeDemandScore({
    ...EMPTY,
    sales24h: 40, sales7d: 70, sales30d: 300,
  });
  assert.equal(result.gradable, true);
  const momentumPart = result.parts.find((p) => p.label.startsWith("Volume"));
  assert.ok(momentumPart);
  assert.ok(momentumPart!.points > 0);
});

test("computeDemandScore scores presence-only momentum when there is no historical baseline at all", () => {
  const result = computeDemandScore({
    ...EMPTY,
    volume24hWei: "500", volume7dWei: "0", volume30dWei: "0",
  });
  const momentumPart = result.parts.find((p) => p.label.startsWith("Volume"));
  assert.ok(momentumPart);
  assert.equal(momentumPart!.points, momentumPart!.max);
});

test("computeDemandScore ignores a missing field rather than treating it as zero", () => {
  const withListedOnly = computeDemandScore({ ...EMPTY, listedCount: 40, totalSupply: 100 });
  assert.equal(withListedOnly.parts.length, 1);
  assert.equal(withListedOnly.parts[0]!.label.startsWith("Listed depth"), true);
});

test("computeDemandScore never exceeds 100 or goes below 0 even with maxed-out real inputs", () => {
  const maxed = computeDemandScore({
    volume24hWei: String(1_000_000), volume7dWei: String(7 * 1_000), volume30dWei: String(30 * 1_000),
    sales24h: null, sales7d: null, sales30d: null,
    listedCount: 100, totalSupply: 100, holderCount: 100,
    rankedTokenCount: 100, projectedTokenCount: 100,
  });
  assert.ok(maxed.score <= 100);
  assert.ok(maxed.score >= 0);
});

test("computeDemandScore guards divide-by-zero on totalSupply=0 by ignoring the ratio", () => {
  const result = computeDemandScore({ ...EMPTY, listedCount: 5, totalSupply: 0, holderCount: 5 });
  assert.equal(result.parts.length, 0);
  assert.equal(result.gradable, false);
});

test("computeDemandScore ignores non-finite/garbage wei strings instead of throwing", () => {
  const result = computeDemandScore({
    ...EMPTY,
    volume24hWei: "not-a-number", volume7dWei: "not-a-number", volume30dWei: "not-a-number",
  });
  assert.equal(result.parts.length, 0);
  assert.equal(result.gradable, false);
});
