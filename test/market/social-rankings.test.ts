import assert from "node:assert/strict";
import test from "node:test";
import {
  endorsementWeight,
  MIN_STANDING_MULTIPLIER,
  rankByWeightedEndorsements,
  standingMultiplier,
} from "../../lib/social-rankings";

// --- pure scoring formulas ------------------------------------------------

test("standingMultiplier is 1 for a clean wallet and floors at MIN_STANDING_MULTIPLIER for full severity", () => {
  assert.equal(standingMultiplier(0), 1);
  assert.ok(Math.abs(standingMultiplier(1) - MIN_STANDING_MULTIPLIER) < 1e-9);
});

test("standingMultiplier is monotonic and clamps out-of-range severity", () => {
  const low = standingMultiplier(0.25);
  const high = standingMultiplier(0.75);
  assert.ok(low > high);
  assert.equal(standingMultiplier(-5), 1);
  assert.ok(Math.abs(standingMultiplier(5) - MIN_STANDING_MULTIPLIER) < 1e-9);
});

test("endorsementWeight is zero for a wallet with zero (or negative/NaN) point history — a fresh sybil throwaway contributes nothing", () => {
  assert.equal(endorsementWeight({ pointTotal: 0, badSeverity: 0 }), 0);
  assert.equal(endorsementWeight({ pointTotal: -100, badSeverity: 0 }), 0);
  assert.equal(endorsementWeight({ pointTotal: Number.NaN, badSeverity: 0 }), 0);
});

test("endorsementWeight sublinearly rewards larger point totals — a wallet with 100x the points does not get 100x the vote", () => {
  const small = endorsementWeight({ pointTotal: 100, badSeverity: 0 });
  const large = endorsementWeight({ pointTotal: 10_000, badSeverity: 0 });
  assert.ok(large > small);
  assert.ok(large < small * 100);
  // sqrt relationship exactly: 10_000 has 100x the points of 100, so the
  // weight should be exactly 10x (sqrt(100) = 10).
  assert.ok(Math.abs(large / small - 10) < 1e-9);
});

test("endorsementWeight discounts a flagged wallet's vote relative to an identical clean wallet, but never to zero", () => {
  const clean = endorsementWeight({ pointTotal: 5_000, badSeverity: 0 });
  const flagged = endorsementWeight({ pointTotal: 5_000, badSeverity: 1 });
  assert.ok(flagged < clean);
  assert.ok(flagged > 0);
  assert.ok(Math.abs(flagged / clean - MIN_STANDING_MULTIPLIER) < 1e-9);
});

test("a sybil swarm of throwaway wallets still loses to one wallet with real history — the whole point of weighting by reputation, not vote count", () => {
  const sybilVotes = Array.from({ length: 50 }, () => ({
    targetId: "collection-a",
    voter: { pointTotal: 0, badSeverity: 0 }, // fresh throwaway wallets, no real history
  }));
  const realVote = [
    { targetId: "collection-b", voter: { pointTotal: 1_000_000, badSeverity: 0 } },
  ];
  const ranked = rankByWeightedEndorsements([...sybilVotes, ...realVote]);
  assert.equal(ranked[0].targetId, "collection-b");
  assert.ok(ranked[0].score > (ranked.find((r) => r.targetId === "collection-a")?.score ?? 0));
});

test("rankByWeightedEndorsements aggregates multiple voters per target and sorts highest score first", () => {
  const ranked = rankByWeightedEndorsements([
    { targetId: "a", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "a", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "b", voter: { pointTotal: 10_000, badSeverity: 0 } },
  ]);
  assert.equal(ranked[0].targetId, "b");
  assert.equal(ranked[1].targetId, "a");
  assert.equal(ranked[1].voteCount, 2);
});

test("rankByWeightedEndorsements breaks ties deterministically by targetId", () => {
  const ranked = rankByWeightedEndorsements([
    { targetId: "zeta", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "alpha", voter: { pointTotal: 100, badSeverity: 0 } },
  ]);
  assert.equal(ranked[0].targetId, "alpha");
  assert.equal(ranked[1].targetId, "zeta");
});
