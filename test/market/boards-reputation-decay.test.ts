import assert from "node:assert/strict";
import test from "node:test";
import {
  decayedBadSeverity,
  nextGoodStreakDays,
  REPUTATION_DECAY_FULL_DAYS,
} from "../../lib/boards";

// --- pure decay formulas ---------------------------------------------------

test("decayedBadSeverity is full weight (1) at zero streak days", () => {
  assert.equal(decayedBadSeverity(0), 1);
});

test("decayedBadSeverity fades linearly toward zero as the good streak grows", () => {
  const quarter = decayedBadSeverity(REPUTATION_DECAY_FULL_DAYS / 4);
  const half = decayedBadSeverity(REPUTATION_DECAY_FULL_DAYS / 2);
  assert.ok(Math.abs(quarter - 0.75) < 1e-9);
  assert.ok(Math.abs(half - 0.5) < 1e-9);
  assert.ok(half < quarter);
});

test("decayedBadSeverity clamps at zero for a streak at or past the full-decay threshold — never negative", () => {
  assert.equal(decayedBadSeverity(REPUTATION_DECAY_FULL_DAYS), 0);
  assert.equal(decayedBadSeverity(REPUTATION_DECAY_FULL_DAYS * 10), 0);
});

test("decayedBadSeverity treats invalid input as zero streak (full severity), never NaN or negative", () => {
  assert.equal(decayedBadSeverity(Number.NaN), 1);
  assert.equal(decayedBadSeverity(-5), 1);
});

test("nextGoodStreakDays starts a fresh streak at 1 with no prior tick", () => {
  const now = new Date("2026-08-04T12:00:00Z").toISOString();
  assert.equal(nextGoodStreakDays(0, null, now), 1);
  assert.equal(nextGoodStreakDays(0, undefined, now), 1);
});

test("nextGoodStreakDays does not double-count a second tick on the same calendar day", () => {
  const first = new Date("2026-08-04T08:00:00Z").toISOString();
  const sameDayLater = new Date("2026-08-04T20:00:00Z").toISOString();
  assert.equal(nextGoodStreakDays(3, first, sameDayLater), 3);
});

test("nextGoodStreakDays increments by 1 for exactly the next consecutive calendar day", () => {
  const yesterday = new Date("2026-08-03T09:00:00Z").toISOString();
  const today = new Date("2026-08-04T09:00:00Z").toISOString();
  assert.equal(nextGoodStreakDays(5, yesterday, today), 6);
});

test("nextGoodStreakDays resets to 1 when a day is skipped — a broken streak restarts, it does not just stall", () => {
  const threeDaysAgo = new Date("2026-08-01T09:00:00Z").toISOString();
  const today = new Date("2026-08-04T09:00:00Z").toISOString();
  assert.equal(nextGoodStreakDays(20, threeDaysAgo, today), 1);
});

test("nextGoodStreakDays never goes backward on out-of-order/clock-skew input", () => {
  const later = new Date("2026-08-04T09:00:00Z").toISOString();
  const earlier = new Date("2026-08-01T09:00:00Z").toISOString();
  assert.equal(nextGoodStreakDays(10, later, earlier), 1);
});

test("a sustained streak eventually fully clears a mark's severity — the whole point of decay existing", () => {
  let streak = 0;
  let lastMark: string | null = null;
  const start = Date.parse("2026-01-01T00:00:00Z");
  for (let day = 0; day < REPUTATION_DECAY_FULL_DAYS; day++) {
    const tickIso = new Date(start + day * 24 * 60 * 60 * 1000).toISOString();
    streak = nextGoodStreakDays(streak, lastMark, tickIso);
    lastMark = tickIso;
  }
  assert.equal(streak, REPUTATION_DECAY_FULL_DAYS);
  assert.equal(decayedBadSeverity(streak), 0);
});
