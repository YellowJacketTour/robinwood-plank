/**
 * CCS-2L dedicated named campaigns. Each scenario asserts the two conservation
 * identities on every settlement and prints its finding. Exit 0 iff all pass.
 *
 * Scenarios: coalition, manufactured-round (A vs C), whale/top-lock,
 * all-low-lock, all-high-lock, sole-survivor, zero-survivor, tiny-pool,
 * maximum-seat, cap-saturation, 1-wei boundary.
 *
 * Usage: node scenarios.mjs
 */
import {
  BPS,
  DEFAULT_CCS2L,
  settleCcs2L,
  roundEconomics,
  deriveCrashBps,
  makeRng,
  rngBelow,
} from "./engine.mjs";

const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const RAKE = 300n;
const RESERVE = E(500);
let failures = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) {
    failures++;
    console.error(`FAIL ${name} ${detail}`);
  }
};

function settleRound(seats, crash, seed, params = DEFAULT_CCS2L, reserve = RESERVE) {
  const econ = roundEconomics(seed, seats.map((s) => s.stake), RAKE);
  const r = settleCcs2L(econ.playerDistributable, seed, crash, seats, reserve, params);
  if (r.allBust) {
    ok("conserve-bust", r.bustedToReserve === econ.playerDistributable + seed);
  } else {
    ok("conserve-player", r.totalPlayerPaid === econ.playerDistributable);
    ok("conserve-house", r.totalBonus + r.houseReturned === seed);
  }
  ok("treasury-zero", r.treasuryCapResidue === 0n);
  return { econ, r };
}
const pct = (num, den) => (den === 0n ? "n/a" : (Number((num * 10_000n) / den) / 100).toFixed(2) + "%");

// ── whale/top-lock: 90% whale scans its lock; coalition ladder vs single ──
console.log("\n== whale/top-lock + coalition ==");
{
  const others = [
    { id: "e1", stake: E(0.5), targetBps: 14_000n },
    { id: "e2", stake: E(0.5), targetBps: 20_000n },
    { id: "e3", stake: E(0.5), targetBps: 30_000n },
    { id: "e4", stake: E(0.5), targetBps: 45_000n },
  ];
  const crash = 400_000n;
  const seed = E(0.05);
  let bestNet = null;
  for (const m of [10_100n, 20_000n, 27_183n, 100_000n, 398_300n]) {
    const seats = others.concat([{ id: "whale", stake: E(18), targetBps: m }]);
    const { r } = settleRound(seats, crash, seed);
    const w = r.allocations.find((a) => a.id === "whale");
    const net = Number((w.net * 10_000n) / w.stake) / 100;
    console.log(`  whale @${Number(m) / 10000}x -> net ${net.toFixed(2)}%`);
    if (bestNet === null || net > bestNet) bestNet = net;
  }
  // 6-wallet coalition ladder, same 18-token budget
  const ladder = [10_100n, 20_000n, 27_183n, 60_000n, 150_000n, 398_300n].map((m, i) => ({
    id: `c${i}`,
    stake: E(3),
    targetBps: m,
  }));
  const { r } = settleRound(others.concat(ladder), crash, seed);
  const coalNet = ladder.reduce((a, l) => a + r.allocations.find((x) => x.id === l.id).net, 0n);
  const coalPct = Number((coalNet * 10_000n) / E(18)) / 100;
  console.log(`  6-wallet coalition ladder net: ${coalPct.toFixed(2)}%  (best single: ${bestNet.toFixed(2)}%)`);
  ok("whale-no-pump", bestNet < 5 && coalPct < 5, `best=${bestNet} coalition=${coalPct}`);
}

// ── all-low-lock: player purse still fully distributed, RTP = 1 - r exactly ──
console.log("\n== all-low-lock ==");
{
  const seats = Array.from({ length: 10 }, (_, i) => ({
    id: `p${i}`,
    stake: E(1 + (i % 3)),
    targetBps: 10_100n + BigInt(i * 7),
  }));
  const { econ, r } = settleRound(seats, 10_200n, 0n);
  ok("all-low-full-purse", r.totalPlayerPaid === econ.playerDistributable);
  console.log(`  survivors=10/10, player purse paid: ${pct(r.totalPlayerPaid, econ.playerPool)} of stakes (rake 3%)`);
}

// ── all-high-lock: most bust; whoever survives takes the full purse ──
console.log("\n== all-high-lock ==");
{
  const rng = makeRng(99n);
  let purseExact = 0;
  let rounds = 0;
  for (let t = 0; t < 2_000; t++) {
    const seats = Array.from({ length: 8 }, (_, i) => ({
      id: `g${i}`,
      stake: E(2),
      targetBps: 100_000n + rngBelow(rng, 400_000n),
    }));
    const crash = deriveCrashBps(rngBelow(rng, 10_000n));
    const { econ, r } = settleRound(seats, crash, E(0.05));
    rounds++;
    if (!r.allBust && r.totalPlayerPaid === econ.playerDistributable) purseExact++;
    if (r.allBust) purseExact++;
  }
  ok("all-high-exact", purseExact === rounds, `${purseExact}/${rounds}`);
  console.log(`  2,000 all-high rounds: purse identity exact in ${purseExact}/${rounds}`);
}

// ── sole-survivor + zero-survivor ──
console.log("\n== sole-survivor / zero-survivor ==");
{
  const seats = [
    { id: "a", stake: E(1), targetBps: 12_000n },
    { id: "b", stake: E(50), targetBps: 300_000n },
  ];
  const { econ, r } = settleRound(seats, 12_500n, E(1));
  const a = r.allocations[0];
  ok("sole-gets-purse", a.playerPayout === econ.playerDistributable);
  ok("sole-bonus-faircapped", a.houseBonus === (E(1) * (12_000n - BPS)) / BPS / 1n || a.houseBonus <= (a.stake * (12_000n - BPS)) / BPS);
  console.log(`  sole survivor: playerPayout=${a.playerPayout} (= full purse), bonus=${a.houseBonus} (fair-odds capped), houseReturned=${r.houseReturned}`);
  const { r: rz } = settleRound(seats, 10_050n, E(1));
  ok("zero-survivor", rz.allBust && rz.bustedToReserve > 0n && rz.totalPayout === 0n);
  console.log(`  zero survivor: bustedToReserve=${rz.bustedToReserve} (ratified routing), payouts=0`);
}

// ── tiny-pool + 1-wei boundary ──
console.log("\n== tiny-pool / 1-wei ==");
{
  for (const [pd, sd] of [[1n, 0n], [2n, 1n], [97n, 3n], [10_001n, 1n]]) {
    const seats = [
      { id: "x", stake: 50n, targetBps: 15_000n },
      { id: "y", stake: 50n, targetBps: 19_999n },
    ];
    const r = settleCcs2L(pd, sd, 20_000n, seats, RESERVE, DEFAULT_CCS2L);
    ok("tiny-exact", r.totalPlayerPaid === pd && r.totalBonus + r.houseReturned === sd, `pd=${pd}`);
  }
  console.log("  tiny pools (1..10001 wei): both identities exact");
}

// ── maximum-seat: n = 500 ──
console.log("\n== maximum-seat (n=500) ==");
{
  const rng = makeRng(7n);
  const seats = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`,
    stake: 1n + rngBelow(rng, E(3)),
    targetBps: 10_100n + rngBelow(rng, 200_000n),
  }));
  const { econ, r } = settleRound(seats, 150_000n, E(2));
  ok("maxseat-exact", r.totalPlayerPaid === econ.playerDistributable);
  console.log(`  500 seats: purse ${econ.playerDistributable} paid exactly, dust=${r.meta.playerDust} wei (<${r.allocations.filter((a) => a.survived).length} survivors)`);
}

// ── cap-saturation: GLOBAL reserve cap binds; unused seed goes HOME ──────
console.log("\n== cap-saturation ==");
{
  const tiny = E(1);
  const seats = [
    { id: "w", stake: E(20), targetBps: 100_000n },
    { id: "o", stake: E(1), targetBps: 15_000n },
  ];
  const { r } = settleRound(seats, 150_000n, E(50), DEFAULT_CCS2L, tiny);
  const hAvail = (tiny * DEFAULT_CCS2L.houseCapBps) / BPS; // global purse cap
  ok("cap-binds", r.totalBonus <= hAvail && r.totalBonus > 0n, `totalBonus=${r.totalBonus}`);
  ok("cap-home", r.houseReturned > 0n && r.totalBonus + r.houseReturned === E(50));
  console.log(`  seed=50, global hAvail=${hAvail}: aggregate bonus ${r.totalBonus} (identity-independent), houseReturned=${r.houseReturned} -> RESERVE (0 to treasury, 0 confiscated from players)`);
}

// ── manufactured-round farming: variant A vs variant C ──
console.log("\n== manufactured-round farming (why forward-seeding is NON-PREFERRED) ==");
{
  // Attacker plan: round t — bet B at a doomed-high lock hoping to bust the
  // round (or alone in a quiet round), creating carry = 0.97*B under variant C;
  // round t+1 — bet S at 2x and harvest min(carry, S*(2-1)) with P = 1/2.
  // Under variant A the busted pot goes to the PROTECTED RESERVE (drip-fed at
  // 1/200 per round through fair-odds-capped seeds) — no addressable carry.
  const B = E(10);
  const carryC = (B * (BPS - RAKE)) / BPS; // 9.7 under C, addressable next round
  // EV of the harvest leg (sole player, stake S = carry, lock 2x):
  const S = carryC;
  const econ2 = roundEconomics(carryC, [S], RAKE);
  const win = settleCcs2L(econ2.playerDistributable, carryC, 20_000n, [{ id: "h", stake: S, targetBps: 20_000n }], RESERVE);
  const winPayout = win.allocations[0].payout; // full purse + capped bonus
  // P(survive 2x) = 1/2 exactly under _deriveCrash
  const evHarvest = winPayout / 2n - S; // lose S half the time... but under C the
  // busted S itself re-carries, so the true loss on bust is only rake+drift:
  const evHarvestRecursive = winPayout / 2n - (S * RAKE) / BPS / 1n - S / 2n + carryC / 2n;
  console.log(`  variant C: manufacture cost=${B}, carry=${carryC}`);
  console.log(`  harvest leg payout on win=${winPayout} (purse ${econ2.playerDistributable} + bonus ${win.allocations[0].houseBonus})`);
  console.log(`  one-shot harvest EV=${evHarvest} wei; recursive-chase EV=${evHarvestRecursive} wei`);
  console.log(`  -> the attacker recovers OTHER ROUNDS' busted pots: cross-round beneficiary by construction.`);
  // The demonstration required: variant C creates an addressable cross-round
  // transfer (carry > 0 visible pre-bet); variant A's equivalent is 0.
  ok("C-farming-surface-exists", carryC > 0n && win.allocations[0].houseBonus > 0n);
  // v2 (2026-09-05, RESEARCH-game-theory-lottery-seed-resolution): with the
  // round's own rake passed, the house draw is capped at houseRakeCapBps of
  // it -- the same harvest leg can never take more than half its own rake.
  const winV2 = settleCcs2L(econ2.playerDistributable, carryC, 20_000n, [{ id: "h", stake: S, targetBps: 20_000n }], RESERVE, DEFAULT_CCS2L, econ2.rake);
  ok("v2-rake-cap-closes-farming", winV2.allocations[0].houseBonus <= (econ2.rake * DEFAULT_CCS2L.houseRakeCapBps) / BPS && winV2.allocations[0].houseBonus < win.allocations[0].houseBonus,
    `v2 bonus=${winV2.allocations[0].houseBonus} vs v1 ${win.allocations[0].houseBonus}, rake=${econ2.rake}`);
  console.log(`  variant A: addressable carry = 0 (busted pots enter the protected reserve; per-round seed <= reserve/200 and fair-odds capped).`);
}

// ── 2M-campaign cross-check hook: identity flags from the JSONs are asserted
//    by the doc build; here we just re-assert engine determinism ──
console.log("\n== determinism ==");
{
  const seats = [
    { id: "a", stake: E(3), targetBps: 25_000n },
    { id: "b", stake: E(2), targetBps: 40_000n },
  ];
  const r1 = settleRound(seats, 50_000n, E(0.5)).r;
  const r2 = settleRound(seats, 50_000n, E(0.5)).r;
  ok("deterministic", JSON.stringify(r1, (k, v) => (typeof v === "bigint" ? v.toString() : v)) ===
    JSON.stringify(r2, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

console.log(`\nscenarios: ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
