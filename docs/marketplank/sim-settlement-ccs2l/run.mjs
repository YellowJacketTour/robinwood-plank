/**
 * CCS-2L property/invariant suite. Exit 0 iff every required invariant PASSES.
 * Every failure is printed honestly; nothing is filtered.
 *
 * Invariants (per the CCS-2L mandate):
 *  I1 player-funded conservation: sum(playerPayout) + rake (+ all-bust player
 *     pot to reserve) == sum(stakes), exact bigint identity.
 *  I2 house-funded conservation: sum(b_i) + H_returned == H, exact.
 *  I3 treasury receives ZERO player-pot cap residue (structural + asserted).
 *  I4 survivor rounds: sum(playerPayout) == D_players EXACTLY => aggregate
 *     player RTP == 1 - effective_rake as a wei-exact identity.
 *  I5 same-lock AND adjacent-lock sybil neutrality (fair-odds-bounded; the
 *     per-wallet reserve cap relaxation is measured separately and reported).
 *  I6 equal-stake payout monotonicity in accepted lock.
 *  I7 every payout <= player purse share + house purse share
 *     (playerPayout_i <= D_players, b_i <= min(fair-odds cap, wallet cap)).
 *  I8 no settlement reads future-round state (structural: settleCcs2L takes
 *     only current-round inputs; asserted by API shape).
 *  I9 rounding residue deterministic + non-farmable: player dust <
 *     survivorCount wei, awarded to max-weight survivor, stays in player pot.
 *
 * Usage: node run.mjs
 */
import {
  BPS,
  MIN_TARGET_BPS,
  DEFAULT_CCS2L,
  settleCcs2L,
  settleCcs2LBisect,
  roundEconomics,
  deriveCrashBps,
  makeRng,
  rngBelow,
} from "./engine.mjs";

const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
let failures = 0;
let checks = 0;
const results = [];
function check(name, ok, detail = "") {
  checks++;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
}
function section(name, fn) {
  const before = failures;
  fn();
  results.push({ name, pass: failures === before });
  console.log(`${failures === before ? "PASS" : "FAIL"}  ${name}`);
}

const RAKE = 300n;
const RESERVE = E(500);
const rng = makeRng(20260831n);

function randomRound(maxSeats = 20, variant = "ln") {
  const n = 1 + Number(rngBelow(rng, BigInt(maxSeats)));
  const seats = [];
  for (let i = 0; i < n; i++) {
    seats.push({
      id: `s${i}`,
      stake: 1n + rngBelow(rng, E(25)),
      targetBps: 10_100n + rngBelow(rng, 600_000n),
    });
  }
  const crash = deriveCrashBps(rngBelow(rng, 10_000n));
  const seed = rngBelow(rng, 4n) === 0n ? rngBelow(rng, E(2)) : 0n;
  const econ = roundEconomics(seed, seats.map((s) => s.stake), RAKE);
  const params = { ...DEFAULT_CCS2L, playerWeight: variant };
  const r = settleCcs2L(econ.playerDistributable, seed, crash, seats, RESERVE, params);
  return { seats, crash, seed, econ, r, params };
}

// ── I1/I2/I3/I4/I7/I9 over randomized rounds, both player-weight variants ──
section("I1+I2+I3+I4+I7+I9 randomized rounds (8,000 x 2 variants)", () => {
  for (const variant of ["ln", "odds"]) {
    for (let t = 0; t < 8_000; t++) {
      const { seats, econ, seed, r } = randomRound(20, variant);
      const stakes = seats.reduce((a, s) => a + s.stake, 0n);
      // I1 exact player-funded conservation
      check(
        "I1",
        r.totalPlayerPaid + econ.rake + (r.allBust ? econ.playerDistributable : 0n) === stakes,
        `variant=${variant} t=${t}`,
      );
      // I2 exact house-funded conservation
      check("I2", r.totalBonus + r.houseReturned + (r.allBust ? 0n : 0n) === (r.allBust ? 0n : seed) || r.allBust,
        `t=${t}`);
      if (!r.allBust) check("I2b", r.totalBonus + r.houseReturned === seed, `t=${t}`);
      else check("I2c", r.bustedToReserve === econ.playerDistributable + seed && r.totalBonus === 0n, `t=${t}`);
      // I3 structural zero treasury residue
      check("I3", r.treasuryCapResidue === 0n, `t=${t}`);
      // I4 survivor rounds distribute the player purse in full
      if (!r.allBust) check("I4", r.totalPlayerPaid === econ.playerDistributable, `t=${t}`);
      // I7 bounds: per-seat fair-odds cap + GLOBAL reserve-at-lock house cap
      const reserveCap = (RESERVE * DEFAULT_CCS2L.houseCapBps) / BPS;
      const hAvail = seed < reserveCap ? seed : reserveCap;
      check("I7d", r.totalBonus <= hAvail, `t=${t} totalBonus=${r.totalBonus}`);
      for (const a of r.allocations) {
        check("I7a", a.playerPayout <= econ.playerDistributable, `t=${t} ${a.id}`);
        const fairCap = (a.stake * (a.targetBps - BPS)) / BPS;
        check("I7b", a.houseBonus <= fairCap, `t=${t} ${a.id}`);
        check("I7c", !a.survived ? a.payout === 0n : true, `t=${t} ${a.id}`);
      }
      // I9 dust bound
      const survivors = r.allocations.filter((a) => a.survived).length;
      check("I9", r.meta.playerDust < BigInt(Math.max(survivors, 1)), `t=${t} dust=${r.meta.playerDust}`);
    }
  }
});

// ── I5 sybil: same-lock and adjacent-lock splits never gain (fair-odds bound) ──
section("I5 sybil same-lock + adjacent-lock splits (600 rounds x 8 patterns)", () => {
  let worstGain = 0n;
  for (let t = 0; t < 600; t++) {
    const { seats, crash, seed, params } = randomRound(10);
    // candidate target: a surviving seat, else skip
    const idx = seats.findIndex((s) => s.targetBps <= crash);
    if (idx < 0) continue;
    const s0 = seats[idx];
    const patterns = [
      [[s0.stake / 2n, 0n], [s0.stake - s0.stake / 2n, 0n]],
      [[s0.stake / 3n, 0n], [s0.stake / 3n, 0n], [s0.stake - 2n * (s0.stake / 3n), 0n]],
      [[s0.stake / 2n, 1n], [s0.stake - s0.stake / 2n, 0n]],
      [[s0.stake / 2n, -1n], [s0.stake - s0.stake / 2n, 0n]],
      [[s0.stake / 2n, 1n], [s0.stake - s0.stake / 2n, -1n]],
      [[s0.stake / 4n, 0n], [s0.stake / 4n, 1n], [s0.stake / 4n, -1n], [s0.stake - 3n * (s0.stake / 4n), 2n]],
      [[s0.stake / 5n, 0n], [s0.stake / 5n, 0n], [s0.stake / 5n, 0n], [s0.stake / 5n, 0n], [s0.stake - 4n * (s0.stake / 5n), 0n]],
      [[s0.stake / 2n, 50n], [s0.stake - s0.stake / 2n, -50n]],
    ];
    for (const pat of patterns) {
      const parts = pat
        .map(([st, dm], k) => ({
          id: `split${k}`,
          stake: st,
          targetBps: s0.targetBps + dm < MIN_TARGET_BPS ? MIN_TARGET_BPS : s0.targetBps + dm,
        }))
        .filter((p) => p.stake > 0n);
      // keep only splits whose every part still survives (attacker keeps outcome)
      if (!parts.every((p) => p.targetBps <= crash)) continue;
      // Correct sybil baseline: the FULL stake as ONE seat at the TOP lock used
      // by the split (an upward lock move is monotonicity, not sybil).
      const topLock = parts.reduce((a, p) => (p.targetBps > a ? p.targetBps : a), 0n);
      const baseSeats = seats.map((s, i) => (i === idx ? { ...s0, targetBps: topLock } : s));
      const econB = roundEconomics(seed, baseSeats.map((s) => s.stake), RAKE);
      const rB = settleCcs2L(econB.playerDistributable, seed, crash, baseSeats, RESERVE, params);
      const basePay = rB.allocations[idx].payout;
      const seats2 = seats.filter((_, i) => i !== idx).concat(parts);
      const econ2 = roundEconomics(seed, seats2.map((s) => s.stake), RAKE);
      const r2 = settleCcs2L(econ2.playerDistributable, seed, crash, seats2, RESERVE, params);
      const splitPay = r2.allocations.filter((a) => a.id.startsWith("split")).reduce((a, x) => a + x.payout, 0n);
      const gain = splitPay - basePay;
      if (gain > worstGain) worstGain = gain;
      // Fair-odds-bounded neutrality: allowed slack = dust-award (< n wei) +
      // per-wallet reserve-cap relaxation (measured; 0 unless walletCap bound
      // the unsplit seat — RESERVE here is large so it never binds).
      const survivors2 = r2.allocations.filter((a) => a.survived).length;
      check("I5", gain <= BigInt(survivors2) + 1n, `t=${t} gain=${gain}`);
    }
  }
  console.log(`  worst sybil split gain observed: ${worstGain} wei`);
});

// ── I5b: the v1.0 per-wallet cap relaxation is GONE (partition invariance) ──
section("I5b house cap partition-invariant (v1.1: no per-wallet relaxation)", () => {
  // Tiny reserve so the GLOBAL cap binds hard: one whale survivor vs the same
  // whale split across wallets. Under v1.0 the split DOUBLED the wallet cap;
  // under v1.1 the cap is global, so the split can only lose rounding wei.
  const tinyReserve = E(1);
  const params = { ...DEFAULT_CCS2L };
  const seed = E(5);
  const seats1 = [
    { id: "whale", stake: E(10), targetBps: 30_000n },
    { id: "other", stake: E(1), targetBps: 15_000n },
  ];
  const econ1 = roundEconomics(seed, seats1.map((s) => s.stake), RAKE);
  const r1 = settleCcs2L(econ1.playerDistributable, seed, 40_000n, seats1, tinyReserve, params);
  const seats2 = [
    { id: "whaleA", stake: E(5), targetBps: 30_000n },
    { id: "whaleB", stake: E(5), targetBps: 30_000n },
    { id: "other", stake: E(1), targetBps: 15_000n },
  ];
  const econ2 = roundEconomics(seed, seats2.map((s) => s.stake), RAKE);
  const r2 = settleCcs2L(econ2.playerDistributable, seed, 40_000n, seats2, tinyReserve, params);
  const one = r1.allocations[0].houseBonus;
  const two = r2.allocations[0].houseBonus + r2.allocations[1].houseBonus;
  const hAvail = (tinyReserve * params.houseCapBps) / BPS;
  console.log(`  unsplit bonus=${one} split bonus=${two} global hAvail=${hAvail}`);
  check("I5b-no-gain", two <= one, `split gained ${two - one} wei`);
  check("I5b-global-cap", r1.totalBonus <= hAvail && r2.totalBonus <= hAvail, `caps`);
  // Exhaustive partition searches live in partition.mjs (same-lock,
  // adjacent-lock, multi-target, multi-wallet) — the acceptance criterion.
});

// ── I6 equal-stake monotonicity in accepted lock ──
section("I6 equal-stake successful-payout monotonicity (4,000 paired probes)", () => {
  for (let t = 0; t < 4_000; t++) {
    const { seats, crash, seed, params } = randomRound(12);
    if (crash < MIN_TARGET_BPS + 2n) continue;
    const stake = 1n + rngBelow(rng, E(5));
    const mHi = MIN_TARGET_BPS + rngBelow(rng, crash - MIN_TARGET_BPS);
    const mLo = MIN_TARGET_BPS + rngBelow(rng, mHi - MIN_TARGET_BPS + 1n);
    const probeSeats = seats.concat([
      { id: "probeLo", stake, targetBps: mLo },
      { id: "probeHi", stake, targetBps: mHi },
    ]);
    const econ2 = roundEconomics(seed, probeSeats.map((s) => s.stake), RAKE);
    const r = settleCcs2L(econ2.playerDistributable, seed, crash, probeSeats, RESERVE, params);
    const lo = r.allocations.find((a) => a.id === "probeLo");
    const hi = r.allocations.find((a) => a.id === "probeHi");
    // both survive by construction; allow dust-award wei (goes to max weight)
    check("I6", hi.payout + r.meta.playerDust >= lo.payout, `t=${t} lo=${lo.payout} hi=${hi.payout}`);
  }
});

// ── I8 structural: settlement input surface ──
section("I8 no future-round reads (structural)", () => {
  check("I8", settleCcs2L.length === 5, "settleCcs2L(playerD, seedH, crash, seats, reserveAtLock, params=default)");
});

// ── 1-wei boundary probes ──
section("1-wei boundary probes (2,000)", () => {
  let maxDelta = 0n;
  for (let t = 0; t < 2_000; t++) {
    const { seats, crash, seed, econ, params } = randomRound(8);
    const idx = Number(rngBelow(rng, BigInt(seats.length)));
    const seats2 = seats.map((s, i) => (i === idx ? { ...s, stake: s.stake + 1n } : s));
    const econ2 = roundEconomics(seed, seats2.map((s) => s.stake), RAKE);
    const r1 = settleCcs2L(econ.playerDistributable, seed, crash, seats, RESERVE, params);
    const r2 = settleCcs2L(econ2.playerDistributable, seed, crash, seats2, RESERVE, params);
    for (let i = 0; i < seats.length; i++) {
      if (i === idx) continue;
      const d = r2.allocations[i].payout - r1.allocations[i].payout;
      const abs = d < 0n ? -d : d;
      // exclude dust-award reassignment wei
      const survivors = r1.allocations.filter((a) => a.survived).length || 1;
      if (abs > maxDelta) maxDelta = abs;
      // dust-award reassignment can move up to dust_before + dust_after
      // (< 2*survivors wei) between seats, plus the analytic 1-wei slope.
      check("1wei", abs <= 2n * BigInt(survivors) + 2n, `t=${t} i=${i} delta=${d}`);
    }
  }
  console.log(`  max non-perturbed-seat payout delta from 1-wei stake change: ${maxDelta} wei`);
});

// ── closed-form vs 90-halving bisection cross-check ──
section("closed-form lambda == bisection limit (dust-only difference, 1,000)", () => {
  for (let t = 0; t < 1_000; t++) {
    const { seats, crash, econ, params, r } = randomRound(10);
    if (r.allBust || r.meta.mode !== "normal") continue;
    const b = settleCcs2LBisect(econ.playerDistributable, crash, seats, params);
    if (!b || b.saturated) continue;
    // bisection under-pays into grid dust; closed form distributes it all
    check("bisect-dust", b.dust >= 0n, `t=${t}`);
    const bSum = b.payouts.reduce((a, x) => a + x, 0n);
    check("bisect-sum", bSum + b.dust === econ.playerDistributable, `t=${t}`);
    for (let i = 0; i < seats.length; i++) {
      const d = r.allocations[i].playerPayout - b.payouts[i];
      // per-seat difference is bounded by total dust of both schemes
      check("bisect-seat", d >= 0n && d <= b.dust + r.meta.playerDust, `t=${t} i=${i} d=${d}`);
    }
  }
});

// ── floor-degenerate branch (defensive; needs f > 1 - rake) ──
section("floor-degenerate branch defined + exact", () => {
  const params = { ...DEFAULT_CCS2L, floorBps: 9_900n }; // f > 9700 = 1 - rake
  const seats = [
    { id: "a", stake: E(4), targetBps: 20_000n },
    { id: "b", stake: E(4), targetBps: 30_000n },
  ];
  const econ = roundEconomics(0n, seats.map((s) => s.stake), RAKE);
  const r = settleCcs2L(econ.playerDistributable, 0n, 40_000n, seats, RESERVE, params);
  check("floor-mode", r.meta.mode === "floor-degenerate", r.meta.mode);
  check("floor-exact", r.totalPlayerPaid === econ.playerDistributable, "");
  // and with default f, the branch is unreachable in normal operation
  const r2 = settleCcs2L(econ.playerDistributable, 0n, 40_000n, seats, RESERVE, DEFAULT_CCS2L);
  check("floor-unreachable-default", r2.meta.mode === "normal", r2.meta.mode);
});

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
