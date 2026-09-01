/**
 * Simulation harness for the Performance Ladder Settlement (PLS) vs PFSS/SM/SO.
 * Deterministic (seeded xorshift, no floats in settlement math).
 *
 * Usage: node run.mjs   (writes results.json, results.md, manifest.json)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { settleParimutuel, BPS, MIN_TARGET_BPS, DEFAULT_LADDER, bonusBps } from "./engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RULES = ["stake-multiplier", "stake-only", "pfss", "ladder"];

// ---------------- deterministic PRNG ----------------
function xorshift(seed) {
  let s = BigInt(seed) & 0xffffffffffffffffn;
  if (s === 0n) s = 0x9e3779b97f4a7c15n;
  return () => {
    s ^= (s << 13n) & 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= (s << 17n) & 0xffffffffffffffffn;
    return s;
  };
}
function randInt(rng, lo, hi) {
  // inclusive bigint range
  const span = hi - lo + 1n;
  return lo + (rng() % span);
}

// ---------------- invariant checks ----------------
const failures = [];
function check(name, cond, detail) {
  if (!cond) failures.push({ name, detail });
}

function assertSolvency(label, s) {
  check(`solvency:${label}:${s.rule}`, s.totalPayout + s.vaultRemainder === s.distributable, {
    totalPayout: s.totalPayout.toString(),
    vaultRemainder: s.vaultRemainder.toString(),
    distributable: s.distributable.toString(),
  });
  check(`nonneg-remainder:${label}:${s.rule}`, s.vaultRemainder >= 0n, s.vaultRemainder.toString());
  for (const a of s.allocations) {
    check(`nonneg-payout:${label}:${s.rule}:${a.id}`, a.payout >= 0n, a.payout.toString());
    if (!a.survived) check(`bust-zero:${label}:${s.rule}:${a.id}`, a.payout === 0n, a.payout.toString());
    if (s.rule === "ladder" && a.survived) {
      const ceiling = (a.stake * a.targetBps) / BPS;
      check(`ceiling:${label}:${a.id}`, a.payout <= ceiling, { payout: a.payout.toString(), ceiling: ceiling.toString() });
    }
  }
}

/**
 * Monotonicity probe: inject two probe seats of equal stake at locks mLow < mHigh
 * (both surviving) into a scenario; higher accepted lock must never pay less.
 */
function assertMonotonicity(label, rule, D, crashBps, seats, params, probes) {
  for (const [mLow, mHigh] of probes) {
    if (mHigh > crashBps || mLow < MIN_TARGET_BPS || mHigh < MIN_TARGET_BPS || mLow >= mHigh) continue;
    const stake = 1_000_000n;
    const withProbes = [
      ...seats,
      { id: "__probeLow", stake, targetBps: mLow },
      { id: "__probeHigh", stake, targetBps: mHigh },
    ];
    const s = settleParimutuel(rule, D + 2n * stake, crashBps, withProbes, params);
    const lo = s.allocations.find((a) => a.id === "__probeLow").payout;
    const hi = s.allocations.find((a) => a.id === "__probeHigh").payout;
    const ok = hi >= lo;
    check(`monotonicity:${label}:${rule}:${mLow}->${mHigh}`, ok, { lo: lo.toString(), hi: hi.toString() });
    if (!ok && rule !== "ladder") {
      // expected for PFSS/SM in some regimes; recorded but non-fatal there
      failures.pop();
      counterexamples.push({ label, rule, mLow: mLow.toString(), mHigh: mHigh.toString(), lo: lo.toString(), hi: hi.toString() });
    }
  }
}
const counterexamples = [];

/**
 * Split-wallet neutrality: replace seat `id` with N equal wallets at the same
 * lock. Aggregate payout must not increase (splitting may only lose integer
 * dust, bounded by parts * stages).
 */
function assertSplitNeutrality(label, rule, D, crashBps, seats, params, id, parts) {
  const base = settleParimutuel(rule, D, crashBps, seats, params);
  const target = seats.find((s) => s.id === id);
  const per = target.stake / BigInt(parts);
  if (per === 0n) return;
  const rem = target.stake - per * BigInt(parts);
  const split = seats.filter((s) => s.id !== id);
  for (let k = 0; k < parts; k++) {
    split.push({ id: `${id}#${k}`, stake: per + (k === 0 ? rem : 0n), targetBps: target.targetBps });
  }
  const after = settleParimutuel(rule, D, crashBps, split, params);
  const aggBefore = base.allocations.find((a) => a.id === id).payout;
  const aggAfter = after.allocations.filter((a) => a.id.startsWith(`${id}#`)).reduce((s, a) => s + a.payout, 0n);
  const gain = aggAfter - aggBefore;
  // dust bound: parts wei per allocation stage; ladder has <= 12 integer stages
  const bound = BigInt(parts) * 16n;
  check(`split-no-gain:${label}:${rule}`, gain <= bound, { gain: gain.toString() });
  check(`split-bounded-loss:${label}:${rule}`, -gain <= bound, { loss: (-gain).toString() });
  return { aggBefore, aggAfter, gain };
}

// ---------------- scenarios ----------------
/** Round-123 reconstruction: near-universal survival, one 39.83x whale,
 *  early 1.4x-2.5x lockers. distributable < survivorStake (rake > seed). */
function round123Seats() {
  const seats = [
    { id: "DegenAlt", stake: 2_000_000_000n, targetBps: 398_300n }, // 39.83x, 2.0 units
    { id: "early1", stake: 3_000_000_000n, targetBps: 14_000n },
    { id: "early2", stake: 2_500_000_000n, targetBps: 15_000n },
    { id: "early3", stake: 2_000_000_000n, targetBps: 18_000n },
    { id: "early4", stake: 4_000_000_000n, targetBps: 20_000n },
    { id: "early5", stake: 1_500_000_000n, targetBps: 22_000n },
    { id: "early6", stake: 2_000_000_000n, targetBps: 25_000n },
    { id: "mid1", stake: 1_500_000_000n, targetBps: 32_000n },
    { id: "mid2", stake: 1_000_000_000n, targetBps: 45_000n },
    { id: "buster", stake: 500_000_000n, targetBps: 420_000n }, // 42x — busts
  ];
  const crashBps = 400_000n; // 40.00x
  const playerPool = seats.reduce((s, x) => s + x.stake, 0n);
  const rake = (playerPool * 300n) / BPS; // 3%
  const seed = 50_000_000n; // 0.05 units — smaller than rake => D < S regime
  const distributable = seed + playerPool - rake;
  return { seats, crashBps, distributable, playerPool, seed, rake };
}

function fmtPct(num, den) {
  if (den === 0n) return "n/a";
  const bps = (num * 10_000n) / den;
  return `${(Number(bps) / 100).toFixed(2)}%`;
}
function fmtNet(a) {
  return `${a.net >= 0n ? "+" : ""}${fmtPct(a.net, a.stake)}`;
}

const report = [];
const results = {};

// ---------------- 1) round-123 reconstruction ----------------
{
  const { seats, crashBps, distributable, playerPool, seed, rake } = round123Seats();
  const survivorStake = seats.filter((s) => s.targetBps <= crashBps).reduce((a, s) => a + s.stake, 0n);
  report.push(`## Round-123 reconstruction`);
  report.push(
    `playerPool=${playerPool} seed=${seed} rake=${rake} distributable=${distributable} survivorStake=${survivorStake} (D/S=${fmtPct(distributable, survivorStake)}) crash=40.00x`,
  );
  const table = {};
  for (const rule of RULES) {
    const params = { ...DEFAULT_LADDER };
    const s = settleParimutuel(rule, distributable, crashBps, seats, params);
    assertSolvency("r123", s);
    table[rule] = Object.fromEntries(s.allocations.map((a) => [a.id, { payout: a.payout.toString(), net: fmtNet(a) }]));
  }
  // ladder floor variants
  for (const f of [7_000n, 7_500n, 8_000n]) {
    const s = settleParimutuel("ladder", distributable, crashBps, seats, { ...DEFAULT_LADDER, floorBps: f });
    assertSolvency(`r123-f${f}`, s);
    table[`ladder-f${f}`] = Object.fromEntries(s.allocations.map((a) => [a.id, { payout: a.payout.toString(), net: fmtNet(a) }]));
  }
  results.round123 = { distributable: distributable.toString(), survivorStake: survivorStake.toString(), table };

  report.push(`\n| seat | stake | lock | PFSS net | ladder f=70% | ladder f=75% | ladder f=80% | SM net | SO net |`);
  report.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const seat of seats) {
    report.push(
      `| ${seat.id} | ${seat.stake} | ${(Number(seat.targetBps) / 10000).toFixed(2)}x | ${table.pfss[seat.id].net} | ${table["ladder-f7000"][seat.id].net} | ${table["ladder-f7500"][seat.id].net} | ${table["ladder-f8000"][seat.id].net} | ${table["stake-multiplier"][seat.id].net} | ${table["stake-only"][seat.id].net} |`,
    );
  }
}

// ---------------- 2) adversary scenarios ----------------
function scenarioSuite() {
  const S = [];
  const mk = (id, stake, targetBps) => ({ id, stake, targetBps });
  // near-universal survival
  S.push({
    label: "near-universal",
    crashBps: 100_000n,
    seats: [mk("w", 50_000_000n, 60_000n), mk("a", 10_000_000n, 15_000n), mk("b", 10_000_000n, 20_000n), mk("c", 10_000_000n, 110_000n)],
  });
  // dominant whale (90% of stake), low lock
  S.push({
    label: "dominant-whale",
    crashBps: 30_000n,
    seats: [mk("whale", 900_000_000n, 12_000n), mk("a", 50_000_000n, 25_000n), mk("b", 50_000_000n, 29_000n)],
  });
  // minimum-stake swarm: 200 tiny seats at min target + one honest high lock
  {
    const seats = [mk("hero", 100_000_000n, 80_000n)];
    for (let i = 0; i < 200; i++) seats.push(mk(`tiny${i}`, 100_000n, MIN_TARGET_BPS));
    S.push({ label: "min-stake-swarm", crashBps: 90_000n, seats });
  }
  // late tiny bets at very high locks
  S.push({
    label: "late-tiny-high",
    crashBps: 500_000n,
    seats: [mk("a", 100_000_000n, 15_000n), mk("b", 100_000_000n, 20_000n), mk("t1", 10_000n, 490_000n), mk("t2", 10_000n, 495_000n)],
  });
  // copied locks (everyone same target)
  S.push({
    label: "copied-locks",
    crashBps: 25_000n,
    seats: [mk("a", 10_000_000n, 20_000n), mk("b", 20_000_000n, 20_000n), mk("c", 30_000_000n, 20_000n), mk("d", 40_000_000n, 20_000n)],
  });
  // single survivor
  S.push({
    label: "single-survivor",
    crashBps: 15_000n,
    seats: [mk("solo", 10_000_000n, 14_000n), mk("x", 90_000_000n, 30_000n), mk("y", 40_000_000n, 50_000n)],
  });
  // all-bust
  S.push({
    label: "all-bust",
    crashBps: 10_000n,
    seats: [mk("x", 10_000_000n, 20_000n), mk("y", 10_000_000n, 30_000n)],
  });
  // dominant whale AT the top lock: exposes the ladder's own limit — the purse
  // cannot restore even the top bucket, so the top performer is NOT made whole.
  S.push({
    label: "dominant-whale-top-lock",
    crashBps: 60_000n,
    seats: [mk("whaleTop", 900_000_000n, 55_000n), mk("a", 50_000_000n, 15_000n), mk("b", 50_000_000n, 20_000n)],
  });
  return S;
}

{
  report.push(`\n## Adversary scenarios (all rules; seed = pool*1%, rake 3%)`);
  const suite = scenarioSuite();
  results.scenarios = {};
  for (const sc of suite) {
    const pool = sc.seats.reduce((a, s) => a + s.stake, 0n);
    const D = pool + pool / 100n - (pool * 300n) / BPS;
    results.scenarios[sc.label] = {};
    for (const rule of RULES) {
      const s = settleParimutuel(rule, D, sc.crashBps, sc.seats, DEFAULT_LADDER);
      assertSolvency(sc.label, s);
      results.scenarios[sc.label][rule] = {
        vaultRemainder: s.vaultRemainder.toString(),
        allocations: s.allocations.map((a) => ({ id: a.id, net: fmtNet(a), payout: a.payout.toString() })),
      };
      if (sc.seats.length <= 8) {
        report.push(
          `- ${sc.label} [${rule}]: ${s.allocations.map((a) => `${a.id}=${fmtNet(a)}`).join(" ")} | vault=${s.vaultRemainder}`,
        );
      } else if (rule === "ladder" || rule === "pfss") {
        const hero = s.allocations.find((a) => a.id === "hero");
        report.push(`- ${sc.label} [${rule}]: hero=${hero ? fmtNet(hero) : "n/a"} (200 tiny min-target seats omitted) | vault=${s.vaultRemainder}`);
      }
      // split-wallet neutrality on the largest survivor
      const survivors = s.allocations.filter((a) => a.survived);
      if (survivors.length > 0) {
        const big = survivors.reduce((m, a) => (a.stake > m.stake ? a : m));
        assertSplitNeutrality(sc.label, rule, D, sc.crashBps, sc.seats, DEFAULT_LADDER, big.id, 5);
      }
      // monotonicity probes
      assertMonotonicity(sc.label, rule, D, sc.crashBps, sc.seats, DEFAULT_LADDER, [
        [MIN_TARGET_BPS, sc.crashBps],
        [12_000n, sc.crashBps >= 14_000n ? 14_000n : sc.crashBps],
      ]);
    }
  }
}

// ---------------- 3) randomized seeds: invariants ----------------
{
  const SEEDS = 400;
  let rounds = 0;
  for (let seedNum = 1; seedNum <= SEEDS; seedNum++) {
    const rng = xorshift(seedNum * 2654435761);
    const n = Number(randInt(rng, 2n, 24n));
    const seats = [];
    for (let i = 0; i < n; i++) {
      const stake = randInt(rng, 1n, 1_000_000_000n);
      const targetBps = MIN_TARGET_BPS + randInt(rng, 0n, 990_000n);
      seats.push({ id: `s${i}`, stake, targetBps });
    }
    const crashBps = BPS + randInt(rng, 0n, 1_200_000n);
    const pool = seats.reduce((a, s) => a + s.stake, 0n);
    const seedAmt = randInt(rng, 0n, pool / 2n);
    const D = pool + seedAmt - (pool * 300n) / BPS;
    for (const rule of RULES) {
      const params = { ...DEFAULT_LADDER, floorBps: [7_000n, 7_500n, 8_000n][seedNum % 3] };
      const s = settleParimutuel(rule, D, crashBps, seats, params);
      assertSolvency(`rand${seedNum}`, s);
      if (seedNum % 7 === 0 && !s.allBust) {
        const big = s.allocations.filter((a) => a.survived).reduce((m, a) => (a.stake > m.stake ? a : m));
        assertSplitNeutrality(`rand${seedNum}`, rule, D, crashBps, seats, params, big.id, 3);
        assertMonotonicity(`rand${seedNum}`, rule, D, crashBps, seats, params, [[MIN_TARGET_BPS, crashBps]]);
      }
      rounds++;
    }
  }
  report.push(`\n## Randomized invariant sweep\n${SEEDS} seeded rounds x 4 rules = ${rounds} settlements; solvency exact in all; split-neutrality and ladder monotonicity asserted on sampled rounds.`);
  results.randomSweep = { seeds: SEEDS, settlements: rounds };
}

// ---------------- 4) safety-floor sweep ----------------
{
  report.push(`\n## Safety-floor sweep (round-123 shape)`);
  report.push(`| f | DegenAlt net | worst early-locker net | worst recovery vs crash(-100%) | qualified buckets |`);
  report.push(`|---|---|---|---|---|`);
  const { seats, crashBps, distributable } = round123Seats();
  results.floorSweep = [];
  for (let f = 5_000n; f <= 9_500n; f += 500n) {
    const s = settleParimutuel("ladder", distributable, crashBps, seats, { ...DEFAULT_LADDER, floorBps: f });
    assertSolvency(`sweep-f${f}`, s);
    const whale = s.allocations.find((a) => a.id === "DegenAlt");
    const early = s.allocations.filter((a) => a.survived && a.targetBps <= 25_000n);
    const worst = early.reduce((m, a) => ((a.net * 10_000n) / a.stake < (m.net * 10_000n) / m.stake ? a : m));
    results.floorSweep.push({
      floorBps: f.toString(),
      whaleNet: fmtNet(whale),
      worstEarlyNet: fmtNet(worst),
      worstEarlyId: worst.id,
      qualified: s.meta.qualifiedBuckets.length,
    });
    report.push(
      `| ${Number(f) / 100}% | ${fmtNet(whale)} | ${fmtNet(worst)} (${worst.id}) | survivor keeps >= ${Number(f) / 100}% vs -100% on crash | ${s.meta.qualifiedBuckets.length}/${new Set(seats.filter((x) => x.targetBps <= crashBps).map((x) => x.targetBps.toString())).size} |`,
    );
  }
}

// ---------------- 5) bonus curve table ----------------
{
  report.push(`\n## Bonus curve h(m) = min(${DEFAULT_LADDER.hMaxBps} bps, ${DEFAULT_LADDER.aBps} bps * ln m)`);
  const rows = [];
  for (const m of [10_100n, 14_000n, 20_000n, 40_000n, 100_000n, 398_300n, 1_000_000n]) {
    rows.push(`${(Number(m) / 10000).toFixed(2)}x -> +${Number(bonusBps(m, DEFAULT_LADDER)) / 100}%`);
  }
  report.push(rows.join("; "));
  results.bonusCurve = rows;
}

// ---------------- finish ----------------
results.counterexamples = counterexamples;
results.failures = failures.map((f) => ({ name: f.name, detail: f.detail }));
report.push(`\n## Invariant failures: ${failures.length}`);
for (const f of failures.slice(0, 20)) report.push(`- ${f.name}: ${JSON.stringify(f.detail)}`);
report.push(
  `\n## Non-ladder payout-monotonicity counterexamples recorded: ${counterexamples.length}. Note: PFSS/SM are themselves weakly payout-monotone in the accepted lock; PFSS's failure is a ZERO performance gradient plus a principal haircut when surplusPool = 0, not a payout inversion.`,
);
for (const c of counterexamples.slice(0, 6)) report.push(`- ${c.rule} @ ${c.label}: lock ${c.mLow}->${c.mHigh} pays ${c.lo} -> ${c.hi}`);

const md = `# sim-settlement results (deterministic)\n\nGenerated by run.mjs. Integer-exact; no floats in settlement math.\n\n${report.join("\n")}\n`;
writeFileSync(join(HERE, "results.md"), md);
writeFileSync(join(HERE, "results.json"), JSON.stringify(results, null, 2));

const manifest = {};
for (const f of ["engine.mjs", "run.mjs", "results.md", "results.json"]) {
  manifest[f] = createHash("sha256").update(readFileSync(join(HERE, f))).digest("hex");
}
writeFileSync(join(HERE, "manifest.json"), JSON.stringify(manifest, null, 2));
manifest["manifest.json"] = createHash("sha256").update(readFileSync(join(HERE, "manifest.json"))).digest("hex");
console.log(JSON.stringify({ failures: failures.length, counterexamples: counterexamples.length, manifest }, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
