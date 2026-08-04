import assert from "node:assert/strict";
import test from "node:test";
import {
  dilutedEndorsementWeight,
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
  const sybilVotes = Array.from({ length: 50 }, (_, i) => ({
    targetId: "collection-a",
    voterId: `0xsybil${i}`,
    voter: { pointTotal: 0, badSeverity: 0 }, // fresh throwaway wallets, no real history
  }));
  const realVote = [
    { targetId: "collection-b", voterId: "0xreal", voter: { pointTotal: 1_000_000, badSeverity: 0 } },
  ];
  const ranked = rankByWeightedEndorsements([...sybilVotes, ...realVote]);
  assert.equal(ranked[0].targetId, "collection-b");
  assert.ok(ranked[0].score > (ranked.find((r) => r.targetId === "collection-a")?.score ?? 0));
});

test("rankByWeightedEndorsements aggregates multiple voters per target and sorts highest score first", () => {
  const ranked = rankByWeightedEndorsements([
    { targetId: "a", voterId: "0xv1", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "a", voterId: "0xv2", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "b", voterId: "0xv3", voter: { pointTotal: 10_000, badSeverity: 0 } },
  ]);
  assert.equal(ranked[0].targetId, "b");
  assert.equal(ranked[1].targetId, "a");
  assert.equal(ranked[1].voteCount, 2);
});

test("rankByWeightedEndorsements breaks ties deterministically by targetId", () => {
  const ranked = rankByWeightedEndorsements([
    { targetId: "zeta", voterId: "0xv1", voter: { pointTotal: 100, badSeverity: 0 } },
    { targetId: "alpha", voterId: "0xv2", voter: { pointTotal: 100, badSeverity: 0 } },
  ]);
  assert.equal(ranked[0].targetId, "alpha");
  assert.equal(ranked[1].targetId, "zeta");
});

// --- per-voter dilution (closes the pen-test gap: unlimited full-weight
// endorsements from a single wallet) -------------------------------------

test("dilutedEndorsementWeight is undiluted (matches endorsementWeight) for a voter with exactly one live endorsement", () => {
  const voter = { pointTotal: 10_000, badSeverity: 0 };
  assert.equal(dilutedEndorsementWeight(voter, 1), endorsementWeight(voter));
});

test("dilutedEndorsementWeight shrinks as a voter's live endorsement count grows, by exactly sqrt(k)", () => {
  const voter = { pointTotal: 10_000, badSeverity: 0 };
  const full = endorsementWeight(voter);
  assert.ok(Math.abs(dilutedEndorsementWeight(voter, 4) - full / 2) < 1e-9);
  assert.ok(Math.abs(dilutedEndorsementWeight(voter, 9) - full / 3) < 1e-9);
  assert.ok(Math.abs(dilutedEndorsementWeight(voter, 100) - full / 10) < 1e-9);
});

test("dilutedEndorsementWeight treats non-finite/zero/negative counts as k=1 (never divides by zero or amplifies)", () => {
  const voter = { pointTotal: 10_000, badSeverity: 0 };
  const full = endorsementWeight(voter);
  assert.equal(dilutedEndorsementWeight(voter, 0), full);
  assert.equal(dilutedEndorsementWeight(voter, -5), full);
  assert.equal(dilutedEndorsementWeight(voter, Number.NaN), full);
});

test("a single whale wallet endorsing many targets at once cannot out-rank a target with real distinct organic support", () => {
  const whale = { pointTotal: 1_000_000, badSeverity: 0 }; // huge point total
  const whaleTargets = Array.from({ length: 25 }, (_, i) => ({
    targetId: `whale-target-${i}`,
    voterId: "0xwhale",
    voter: whale,
  }));
  // A single whale endorsement, undiluted, would score sqrt(1_000_000) = 1000
  // on each of 25 targets — 25,000 total influence for one click-through.
  // Five ordinary wallets (100 points each) organically endorsing ONE target
  // together should still be able to out-rank any single whale-touched target.
  const organic = Array.from({ length: 5 }, (_, i) => ({
    targetId: "organic-target",
    voterId: `0xorganic${i}`,
    voter: { pointTotal: 100, badSeverity: 0 },
  }));
  const ranked = rankByWeightedEndorsements([...whaleTargets, ...organic]);
  const organicScore = ranked.find((r) => r.targetId === "organic-target")?.score ?? 0;
  const bestWhaleScore = Math.max(
    ...ranked.filter((r) => r.targetId.startsWith("whale-target-")).map((r) => r.score)
  );
  // Diluted: each whale-target now scores only 1000 / sqrt(25) = 200.
  // 5 organic voters at sqrt(100) = 10 each, k=1 (one endorsement each) = 50 total.
  assert.ok(Math.abs(bestWhaleScore - 200) < 1e-6);
  assert.ok(Math.abs(organicScore - 50) < 1e-6);
  // The key regression this guards: dilution meaningfully closes the gap
  // versus the undiluted 1000-vs-50 case — the whale no longer gets full
  // weight on every target simultaneously.
  assert.ok(bestWhaleScore < 1000);
});
