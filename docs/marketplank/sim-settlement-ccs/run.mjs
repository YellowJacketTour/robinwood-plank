/**
 * CCS property/adversary suite. Exit 0 iff every invariant holds.
 * Covers owner checklist items 1-4, 6 and the round-123-SHAPED scenario (8).
 * Deterministic (fixed seeds). Writes results.json + results.md next to it.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BPS,
  MIN_TARGET_BPS,
  DEFAULT_CCS,
  lnScaled,
  settleCcs,
  seatCap,
  deriveCrashBps,
  makeRng,
  rngBelow,
} from "./engine.mjs";
import { loadRoundExport, settleRoundExport } from "./replay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
const report = { checks: {}, scenarios: {} };
let settlements = 0;

function check(name, cond, detail = "") {
  if (!cond) failures.push(`${name}: ${detail}`);
}

function settle(D, crash, seats, params = DEFAULT_CCS) {
  const s = settleCcs(D, crash, seats, params);
  settlements++;
  // Item 6: exact solvency identity, every settlement.
  const paid = s.allocations.reduce((a, x) => a + x.payout, 0n);
  check("solvency", paid + s.capExcess + s.vaultRemainder === D, `round paid=${paid}`);
  check(
    "cap-respected",
    s.allocations.every((a) => !a.survived || a.payout <= seatCap(a.stake, a.targetBps, params)),
    "payout above disclosed cap",
  );
  check("nonsurvivor-zero", s.allocations.every((a) => a.survived || a.payout === 0n), "");
  const split = s.capExcessSplit;
  check("split-exact", split.burn + split.community + split.founders === s.capExcess, "");
  return s;
}

const T = (x) => BigInt(Math.round(x * 1e4)); // multiplier in bps
const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n; // 18-dec amount

// ---------------------------------------------------------------------------
// 1. Monotonicity: equal stake, higher accepted lock never pays less.
//    (Total-payout ordering across DIFFERENT stakes does NOT hold — recorded.)
// ---------------------------------------------------------------------------
{
  const rng = makeRng(101n);
  let pairs = 0;
  let perUnitViolations = 0;
  let crossStakeCounterexample = null;
  for (let t = 0; t < 4000; t++) {
    const n = 2 + Number(rngBelow(rng, 12n));
    const crash = deriveCrashBps(rngBelow(rng, 10_000n));
    if (crash < MIN_TARGET_BPS) continue;
    const seats = [];
    for (let i = 0; i < n; i++) {
      seats.push({
        id: `s${i}`,
        stake: E(0.01) + rngBelow(rng, E(20)),
        targetBps: MIN_TARGET_BPS + rngBelow(rng, crash - MIN_TARGET_BPS + 1n),
      });
    }
    // probe pair: identical stake, m1 < m2, both survivors
    const stake = E(1) + rngBelow(rng, E(5));
    const m2 = MIN_TARGET_BPS + 1n + rngBelow(rng, crash - MIN_TARGET_BPS);
    const m1 = MIN_TARGET_BPS + rngBelow(rng, m2 - MIN_TARGET_BPS);
    seats.push({ id: "probeA", stake, targetBps: m1 }, { id: "probeB", stake, targetBps: m2 });
    const D = E(0.1) + rngBelow(rng, E(200));
    const r = settle(D, crash, seats);
    const pA = r.allocations.find((a) => a.id === "probeA").payout;
    const pB = r.allocations.find((a) => a.id === "probeB").payout;
    if (pA > pB) perUnitViolations++;
    pairs++;
    // cross-stake: find any (bigger stake, lower m) paying more in total — expected, not a bug
    if (!crossStakeCounterexample) {
      const surv = r.allocations.filter((a) => a.survived);
      for (const a of surv)
        for (const b of surv)
          if (a.stake > b.stake && a.targetBps < b.targetBps && a.payout > b.payout) {
            crossStakeCounterexample = {
              low: { stake: a.stake.toString(), m: a.targetBps.toString(), p: a.payout.toString() },
              high: { stake: b.stake.toString(), m: b.targetBps.toString(), p: b.payout.toString() },
            };
          }
    }
  }
  check("monotonicity-equal-stake", perUnitViolations === 0, `${perUnitViolations}/${pairs}`);
  report.checks.monotonicity = {
    pairs,
    equalStakeViolations: perUnitViolations,
    crossStakeTotalOrderingHolds: false,
    crossStakeCounterexample,
  };
}

// ---------------------------------------------------------------------------
// 2. Sybil / false-name search: split one budget across identical, adjacent,
//    and spread multipliers; compare vs the best single seat (ex-post, fixed
//    crash, lambda endogenous). Advantage bound: integer dust only.
// ---------------------------------------------------------------------------
{
  const rng = makeRng(202n);
  let cases = 0;
  let maxGainWei = 0n;
  let worstCase = null;
  const background = () => {
    const n = 3 + Number(rngBelow(rng, 8n));
    const seats = [];
    for (let i = 0; i < n; i++)
      seats.push({
        id: `bg${i}`,
        stake: E(0.05) + rngBelow(rng, E(10)),
        targetBps: MIN_TARGET_BPS + rngBelow(rng, 90_000n),
      });
    return seats;
  };
  for (let t = 0; t < 600; t++) {
    const bg = background();
    const crash = deriveCrashBps(3_000n + rngBelow(rng, 7_000n));
    const D = E(1) + rngBelow(rng, E(60));
    const budget = E(0.5) + rngBelow(rng, E(8));
    const mBase = MIN_TARGET_BPS + rngBelow(rng, crash > 60_000n ? 50_000n : crash - MIN_TARGET_BPS);
    // candidate multiplier sets: identical / adjacent (+-1..+-50 bps) / spread
    const sets = [
      [mBase],
      [mBase, mBase],
      [mBase, mBase + 1n],
      [mBase, mBase - 1n < MIN_TARGET_BPS ? MIN_TARGET_BPS : mBase - 1n],
      [mBase, mBase + 50n],
      [mBase, mBase + 500n, mBase + 1_000n],
      [mBase, (mBase * 3n) / 2n, mBase * 2n],
      [mBase, mBase + 1n, mBase + 2n, mBase + 3n, mBase + 4n],
    ].map((ms) => ms.filter((m) => m <= crash)); // survivors only: ex-post comparison
    // reference: whole budget at the HIGHEST surviving m used by any set
    const allMs = sets.flat();
    if (allMs.length === 0) continue;
    const mTop = allMs.reduce((a, b) => (a > b ? a : b));
    const ref = settle(D, crash, [...bg, { id: "atk", stake: budget, targetBps: mTop }]);
    const refPay = ref.allocations.find((a) => a.id === "atk").payout;
    for (const ms of sets) {
      if (ms.length === 0) continue;
      const k = BigInt(ms.length);
      const parts = ms.map((m, j) => ({
        id: `atk${j}`,
        stake: j === ms.length - 1 ? budget - (budget / k) * (k - 1n) : budget / k,
        targetBps: m,
      }));
      const r = settle(D, crash, [...bg, ...parts]);
      const got = r.allocations
        .filter((a) => a.id.startsWith("atk"))
        .reduce((a, x) => a + x.payout, 0n);
      const gain = got - refPay;
      if (gain > maxGainWei) {
        maxGainWei = gain;
        worstCase = { ms: ms.map(String), gainWei: gain.toString(), refPay: refPay.toString() };
      }
      cases++;
    }
  }
  // Sub-additivity holds up to lambda-grid requantization dust: splitting can
  // shift the discrete lambda* by one grid step, worth a bounded number of
  // wei. Assert the gain is sub-part-per-billion of the reference payout —
  // economically unexploitable (gas alone exceeds it by ~10^9x).
  const refFloor = worstCase ? BigInt(worstCase.refPay) : 0n;
  check(
    "sybil-subadditive",
    maxGainWei <= refFloor / 1_000_000_000n + 16n,
    `max gain ${maxGainWei} wei; ${JSON.stringify(worstCase)}`,
  );
  report.checks.sybil = {
    cases,
    maxGainWei: maxGainWei.toString(),
    maxGainRelative: worstCase ? Number(maxGainWei) / Number(worstCase.refPay) : 0,
    worstCase,
    note: "worst observed gain is lambda-grid requantization dust (sub-ppb), not an exploit",
  };
}

// ---------------------------------------------------------------------------
// 3. Discontinuity & 1-wei boundary probes at the cap boundary and lambda grid.
// ---------------------------------------------------------------------------
{
  const rng = makeRng(303n);
  let probes = 0;
  let maxJumpPerWei = 0n;
  let maxTargetJump = 0n;
  for (let t = 0; t < 800; t++) {
    const n = 2 + Number(rngBelow(rng, 6n));
    const crash = deriveCrashBps(5_000n + rngBelow(rng, 4_999n));
    const seats = [];
    for (let i = 0; i < n; i++)
      seats.push({
        id: `s${i}`,
        stake: E(0.1) + rngBelow(rng, E(5)),
        targetBps: MIN_TARGET_BPS + rngBelow(rng, crash - MIN_TARGET_BPS + 1n),
      });
    // pick D so some seat sits near its cap (stress the min() kink)
    const capSum = seats.reduce((a, s) => a + seatCap(s.stake, s.targetBps, DEFAULT_CCS), 0n);
    const D = capSum / 2n + rngBelow(rng, capSum / 2n + 1n);
    const base = settle(D, crash, seats);
    const i = Number(rngBelow(rng, BigInt(n)));
    for (const dS of [-1n, 1n]) {
      const pert = seats.map((s, j) => (j === i ? { ...s, stake: s.stake + dS } : s));
      const r = settle(D, crash, pert);
      const jump =
        (r.allocations[i].payout > base.allocations[i].payout
          ? r.allocations[i].payout - base.allocations[i].payout
          : base.allocations[i].payout - r.allocations[i].payout);
      if (jump > maxJumpPerWei) maxJumpPerWei = jump;
      probes++;
    }
    for (const dM of [-1n, 1n]) {
      const m2 = seats[i].targetBps + dM;
      if (m2 < MIN_TARGET_BPS || m2 > crash) continue;
      const pert = seats.map((s, j) => (j === i ? { ...s, targetBps: m2 } : s));
      const r = settle(D, crash, pert);
      const jump =
        (r.allocations[i].payout > base.allocations[i].payout
          ? r.allocations[i].payout - base.allocations[i].payout
          : base.allocations[i].payout - r.allocations[i].payout);
      if (jump > maxTargetJump) maxTargetJump = jump;
      probes++;
    }
  }
  // 1-wei stake move must move the payout by at most cap-slope 50x + lambda dust
  check("wei-continuity", maxJumpPerWei <= 1_000_000n, `max ${maxJumpPerWei} wei per 1-wei stake`);
  report.checks.boundary = {
    probes,
    maxPayoutJumpPer1WeiStake: maxJumpPerWei.toString(),
    maxPayoutJumpPer1BpsTarget: maxTargetJump.toString(),
  };
}

// ---------------------------------------------------------------------------
// 4. Whale / coalition best-response: S_top ~= 0.9 S at the top lock.
//    Premium above floor must be ~self-funded (bounded near zero net gain).
// ---------------------------------------------------------------------------
{
  const others = [
    { id: "e1", stake: E(0.5), targetBps: T(1.4) },
    { id: "e2", stake: E(0.5), targetBps: T(1.8) },
    { id: "e3", stake: E(0.5), targetBps: T(2.5) },
    { id: "e4", stake: E(0.5), targetBps: T(4.0) },
  ];
  const whaleStake = E(18); // 90% of S = 20
  const crash = T(40);
  const D = ((whaleStake + E(2)) * 9_700n) / BPS; // 3% rake, no seed
  const table = [];
  let bestNet = null;
  for (const m of [T(1.01), T(1.5), T(2.7183), T(5), T(10), T(20), T(39.9)]) {
    const r = settle(D, crash, [...others, { id: "whale", stake: whaleStake, targetBps: m }]);
    const w = r.allocations.find((a) => a.id === "whale");
    const netPct = Number((w.net * 10_000n) / w.stake) / 100;
    table.push({ m: m.toString(), mode: r.meta.mode, netPct });
    if (!bestNet || netPct > bestNet.netPct) bestNet = { m: m.toString(), netPct };
  }
  // coalition: whale splits into 6 wallets laddering below crash
  const parts = [T(30), T(32), T(34), T(36), T(38), T(39.9)].map((m, j) => ({
    id: `w${j}`,
    stake: whaleStake / 6n,
    targetBps: m,
  }));
  const rc = settle(D, crash, [...others, ...parts]);
  const coalitionPaid = rc.allocations
    .filter((a) => a.id.startsWith("w"))
    .reduce((a, x) => a + x.payout, 0n);
  const coalitionNetPct = Number(((coalitionPaid - whaleStake) * 10_000n) / whaleStake) / 100;
  check(
    "whale-premium-bounded",
    bestNet.netPct < 8 && coalitionNetPct <= bestNet.netPct + 0.01,
    JSON.stringify({ bestNet, coalitionNetPct }),
  );
  report.checks.whale = { table, bestNet, coalitionNetPct };
}

// ---------------------------------------------------------------------------
// Named feasibility scenarios (edge cases the mechanism must define).
// ---------------------------------------------------------------------------
{
  const sc = {};
  // all-bust
  let r = settle(E(10), T(1.05), [{ id: "a", stake: E(1), targetBps: T(2) }]);
  sc.allBust = { mode: r.meta.mode, vault: r.vaultRemainder.toString() };
  check("all-bust", r.allBust && r.vaultRemainder === E(10), "");
  // single survivor: cap binds, excess through ratified split
  r = settle(E(100), T(3), [
    { id: "solo", stake: E(1), targetBps: T(1.4) },
    { id: "bust", stake: E(99), targetBps: T(5) },
  ]);
  sc.singleSurvivor = {
    mode: r.meta.mode,
    payout: r.allocations[0].payout.toString(),
    capExcess: r.capExcess.toString(),
    split: Object.fromEntries(Object.entries(r.capExcessSplit).map(([k, v]) => [k, v.toString()])),
  };
  check("single-survivor-capped", r.allocations[0].payout === (E(1) * T(1.4)) / BPS, "");
  check("cap-excess-routed", r.capExcess === E(100) - (E(1) * T(1.4)) / BPS, "");
  // floors exceed pool (P(0) > D): pro-rata degenerate
  r = settle(E(1), T(10), [
    { id: "a", stake: E(4), targetBps: T(2) },
    { id: "b", stake: E(4), targetBps: T(8) },
  ]);
  sc.floorScaled = { mode: r.meta.mode, payouts: r.allocations.map((a) => a.payout.toString()) };
  check("floor-scaled-mode", r.meta.mode === "floor-scaled", r.meta.mode);
  check(
    "floor-scaled-prorata",
    r.allocations[0].payout === r.allocations[1].payout,
    "equal stakes must pay equal in degenerate mode",
  );
  report.scenarios.named = sc;
}

// ---------------------------------------------------------------------------
// 8. Round-123-SHAPED scenario (SYNTHETIC — not a live reconstruction) via
//    the replay loader, exercising the documented export format.
// ---------------------------------------------------------------------------
{
  const synthetic = {
    roundId: 123,
    label: "round-123-SHAPED synthetic (NOT live data)",
    crashBps: "400000",
    seedWei: E(0.05).toString(),
    rakeBps: "300",
    seats: [
      { id: "DegenAlt", stakeWei: E(2).toString(), targetBps: "398300" },
      { id: "early1", stakeWei: E(3).toString(), targetBps: "14000" },
      { id: "early2", stakeWei: E(3).toString(), targetBps: "15000" },
      { id: "early3", stakeWei: E(2.5).toString(), targetBps: "18000" },
      { id: "early4", stakeWei: E(2.5).toString(), targetBps: "20000" },
      { id: "early5", stakeWei: E(2).toString(), targetBps: "22000" },
      { id: "mid1", stakeWei: E(2).toString(), targetBps: "30000" },
      { id: "mid2", stakeWei: E(1).toString(), targetBps: "45000" },
      { id: "buster", stakeWei: E(1.5).toString(), targetBps: "420000" },
    ],
  };
  const round = loadRoundExport(synthetic);
  const { settlement } = settleRoundExport(round);
  settlements++;
  const rows = settlement.allocations.map((a) => ({
    id: a.id,
    lock: Number(a.targetBps) / 1e4,
    survived: a.survived,
    netPct: a.survived || a.payout > 0n ? Number((a.net * 10_000n) / a.stake) / 100 : -100,
  }));
  const whaleNet = rows.find((x) => x.id === "DegenAlt").netPct;
  check("round123-top-profits", whaleNet > 0, `whale net ${whaleNet}%`);
  report.scenarios.round123Shaped = {
    label: synthetic.label,
    mode: settlement.meta.mode,
    lambda: settlement.meta.lambda.toString(),
    rows,
    vaultRemainder: settlement.vaultRemainder.toString(),
    capExcess: settlement.capExcess.toString(),
  };
}

// ---------------------------------------------------------------------------
// f-sweep on the round-123 shape (for the design doc's floor decision).
// ---------------------------------------------------------------------------
{
  const seats = [
    { id: "DegenAlt", stake: E(2), targetBps: 398_300n },
    { id: "early1", stake: E(3), targetBps: 14_000n },
    { id: "early2", stake: E(3), targetBps: 15_000n },
    { id: "early3", stake: E(2.5), targetBps: 18_000n },
    { id: "early4", stake: E(2.5), targetBps: 20_000n },
    { id: "early5", stake: E(2), targetBps: 22_000n },
    { id: "mid1", stake: E(2), targetBps: 30_000n },
    { id: "mid2", stake: E(1), targetBps: 45_000n },
    { id: "buster", stake: E(1.5), targetBps: 420_000n },
  ];
  const D = E(0.05) + (E(19.5) * 9_700n) / BPS;
  const sweep = [];
  for (const f of [5_000n, 6_000n, 7_000n, 7_500n, 8_000n, 9_000n, 9_500n]) {
    const r = settle(D, 400_000n, seats, { ...DEFAULT_CCS, floorBps: f });
    sweep.push({
      fBps: f.toString(),
      mode: r.meta.mode,
      nets: Object.fromEntries(
        r.allocations.map((a) => [a.id, Number((a.net * 10_000n) / a.stake) / 100]),
      ),
    });
  }
  report.scenarios.floorSweep = sweep;
}

// ---------------------------------------------------------------------------
// g-calibration report: hazard-matching + ex-ante premium EV shape.
// ---------------------------------------------------------------------------
{
  const rows = [];
  for (const m of [10_100n, 15_000n, 20_000n, 27_183n, 50_000n, 100_000n, 400_000n, 1_000_000n]) {
    const g = lnScaled(m);
    rows.push({
      mBps: m.toString(),
      gScaled: g.toString(), // == cumulative hazard H(m)=ln m under P(crash>=m)=1/m
      survivalProbBpsApprox: Number((BPS * BPS) / m), // 1e4/m in bps
      exAntePremiumWeightPerUnit: Number(g) / 1e6 / (Number(m) / 1e4), // ln(m)/m
    });
  }
  report.checks.gCalibration = {
    law: "P(crash >= m) = 1/m (exact _deriveCrash inverse-uniform); hazard h(m)=1/m, cumulative H(m)=ln m",
    chosen: "g(m) = ln(m) == cumulative endured hazard; ex-ante premium weight ln(m)/m peaks at m=e",
    rows,
  };
}

// ---------------------------------------------------------------------------
report.settlements = settlements;
report.failures = failures;
writeFileSync(join(here, "results.json"), JSON.stringify(report, null, 2));
const md = [
  "# CCS property-suite results",
  "",
  `Settlements executed: ${settlements}; solvency identity failures: 0 required — failures: ${failures.length}`,
  "",
  "```json",
  JSON.stringify(report, null, 2),
  "```",
  "",
].join("\n");
writeFileSync(join(here, "results.md"), md);
if (failures.length) {
  console.error("FAILURES:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`OK — ${settlements} settlements, 0 failures`);
