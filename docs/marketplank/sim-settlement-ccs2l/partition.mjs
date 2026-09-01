/**
 * HOUSE-LAYER PARTITION-INVARIANCE PROOF (the acceptance criterion for the
 * v1.1 cap correction).
 *
 * Claim: every house-protection constraint is identity-independent and
 * positively homogeneous in stake, so for ANY partition of any economic
 * position across wallets, the aggregate house bonus of the partition never
 * exceeds the unsplit baseline by more than deterministic rounding dust
 * (< survivorCount wei). (Analytically the integer gain is <= 0: weights and
 * fair caps are additive under splits and floor division is sub-additive;
 * the searches below measure it rather than assume it.)
 *
 * Baselines:
 *  - same-lock / multi-wallet partitions: the full stake as ONE seat at the
 *    same lock.
 *  - adjacent-lock / multi-target partitions: the full stake as ONE seat at
 *    the TOP lock used by the partition (a lock increase is monotonicity, not
 *    sybil, so the top lock is the correct upper envelope).
 *
 * Searches (all deterministic, seed 20260831):
 *  S1 same-lock: every 2-part split on a 64-step stake grid + 1-wei extremes,
 *     plus k = 3..6 equal and skewed compositions, large AND tiny reserve.
 *  S2 adjacent-lock: parts at m, m±1, m±2, m±50 (surviving only).
 *  S3 multi-target: parts spread across the whole surviving lock range.
 *  S4 multi-wallet: k = 2..20 wallets at one lock with a TINY reserve so the
 *     global cap binds hard — the exact configuration where the removed
 *     per-wallet cap was relaxable (v1.0 doubled the cap for 2 wallets).
 *
 * Exit 0 iff worst aggregate gain over every search <= dust bound; the worst
 * observed gain per search is printed and written to partition-results.json.
 *
 * Usage: node partition.mjs
 */
import { writeFileSync } from "node:fs";
import {
  MIN_TARGET_BPS,
  DEFAULT_CCS2L,
  settleCcs2L,
  roundEconomics,
  deriveCrashBps,
  makeRng,
  rngBelow,
} from "./engine.mjs";

const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const RAKE = 300n;
const rng = makeRng(20260831n);
let failures = 0;
const results = {};

function houseBonusOf(r, prefix) {
  return r.allocations.filter((a) => a.id.startsWith(prefix)).reduce((a, x) => a + x.houseBonus, 0n);
}

/**
 * Settle a round with the position unsplit (baseline, at baselineLock) and
 * split (parts), and return the aggregate house-bonus gain of the split.
 */
function gainOf(others, stake, baselineLock, parts, crash, seed, reserve) {
  const base = others.concat([{ id: "pos", stake, targetBps: baselineLock }]);
  const econB = roundEconomics(seed, base.map((s) => s.stake), RAKE);
  const rB = settleCcs2L(econB.playerDistributable, seed, crash, base, reserve, DEFAULT_CCS2L);
  const split = others.concat(parts.map((p, k) => ({ id: `pos${k}`, ...p })));
  const econS = roundEconomics(seed, split.map((s) => s.stake), RAKE);
  const rS = settleCcs2L(econS.playerDistributable, seed, crash, split, reserve, DEFAULT_CCS2L);
  const survivors = rS.allocations.filter((a) => a.survived).length;
  return { gain: houseBonusOf(rS, "pos") - houseBonusOf(rB, "pos"), survivors };
}

function record(name, gain, survivors, detail = "") {
  const bound = BigInt(survivors); // dust bound: < survivorCount wei
  const entry = results[name] ?? { cases: 0, worstGainWei: "0", bound: "survivorCount wei" };
  entry.cases++;
  if (gain > BigInt(entry.worstGainWei)) entry.worstGainWei = gain.toString();
  results[name] = entry;
  if (gain > bound) {
    failures++;
    console.error(`FAIL ${name} gain=${gain} > ${bound} ${detail}`);
  }
}

function randomOthers(maxSeats) {
  const n = 1 + Number(rngBelow(rng, BigInt(maxSeats)));
  const seats = [];
  for (let i = 0; i < n; i++) {
    seats.push({
      id: `o${i}`,
      stake: 1n + rngBelow(rng, E(25)),
      targetBps: 10_100n + rngBelow(rng, 600_000n),
    });
  }
  return seats;
}

const RESERVES = [E(500), E(1), 3n]; // slack cap, binding cap, 1-2 wei purse

// ── S1 same-lock: exhaustive 2-part grid + extremes + k-part compositions ──
{
  for (let t = 0; t < 120; t++) {
    const others = randomOthers(8);
    const crash = deriveCrashBps(5_000n + rngBelow(rng, 5_000n)); // >= 2x
    const m = MIN_TARGET_BPS + rngBelow(rng, crash - MIN_TARGET_BPS);
    const stake = 64n + rngBelow(rng, E(20));
    const seed = rngBelow(rng, E(3));
    for (const reserve of RESERVES) {
      // exhaustive 64-step grid of 2-part splits
      for (let g = 1n; g < 64n; g++) {
        const a = (stake * g) / 64n;
        if (a === 0n || a === stake) continue;
        const { gain, survivors } = gainOf(others, stake, m, [
          { stake: a, targetBps: m },
          { stake: stake - a, targetBps: m },
        ], crash, seed, reserve);
        record("S1-same-lock-2part-grid", gain, survivors, `t=${t} g=${g}`);
      }
      // 1-wei extremes
      for (const a of [1n, stake - 1n]) {
        const { gain, survivors } = gainOf(others, stake, m, [
          { stake: a, targetBps: m },
          { stake: stake - a, targetBps: m },
        ], crash, seed, reserve);
        record("S1-same-lock-1wei-extreme", gain, survivors, `t=${t}`);
      }
      // k = 3..6 equal + skewed compositions
      for (let k = 3n; k <= 6n; k++) {
        const equal = [];
        let rest = stake;
        for (let j = 1n; j < k; j++) {
          equal.push({ stake: stake / k, targetBps: m });
          rest -= stake / k;
        }
        equal.push({ stake: rest, targetBps: m });
        const { gain, survivors } = gainOf(others, stake, m, equal, crash, seed, reserve);
        record("S1-same-lock-kpart", gain, survivors, `t=${t} k=${k}`);
        const skewed = [
          { stake: 1n + rngBelow(rng, stake / 2n), targetBps: m },
        ];
        skewed.push({ stake: stake - skewed[0].stake, targetBps: m });
        const s2 = gainOf(others, stake, m, skewed, crash, seed, reserve);
        record("S1-same-lock-skewed", s2.gain, s2.survivors, `t=${t}`);
      }
    }
  }
}

// ── S2 adjacent-lock: parts at m, m±1, m±2, m±50 (all surviving) ──
{
  for (let t = 0; t < 400; t++) {
    const others = randomOthers(8);
    const crash = deriveCrashBps(5_000n + rngBelow(rng, 5_000n));
    const m = MIN_TARGET_BPS + 60n + rngBelow(rng, crash - MIN_TARGET_BPS - 120n);
    const stake = 4n + rngBelow(rng, E(20));
    const seed = rngBelow(rng, E(3));
    const deltaSets = [
      [0n, 1n], [0n, -1n], [1n, -1n], [2n, -2n], [50n, -50n],
      [0n, 1n, -1n], [0n, 2n, -2n, 50n],
    ];
    for (const reserve of RESERVES) {
      for (const deltas of deltaSets) {
        const parts = [];
        const n = BigInt(deltas.length);
        let rest = stake;
        for (let j = 0; j < deltas.length; j++) {
          const st = j === deltas.length - 1 ? rest : stake / n;
          rest -= j === deltas.length - 1 ? 0n : stake / n;
          let tgt = m + deltas[j];
          if (tgt < MIN_TARGET_BPS) tgt = MIN_TARGET_BPS;
          if (tgt > crash) tgt = crash;
          parts.push({ stake: st, targetBps: tgt });
        }
        const topLock = parts.reduce((a, p) => (p.targetBps > a ? p.targetBps : a), 0n);
        const { gain, survivors } = gainOf(others, stake, topLock, parts, crash, seed, reserve);
        record("S2-adjacent-lock", gain, survivors, `t=${t}`);
      }
    }
  }
}

// ── S3 multi-target: parts spread across the surviving lock range ──
{
  for (let t = 0; t < 400; t++) {
    const others = randomOthers(8);
    const crash = deriveCrashBps(7_000n + rngBelow(rng, 3_000n)); // fat range
    const stake = 8n + rngBelow(rng, E(20));
    const seed = rngBelow(rng, E(3));
    for (const reserve of RESERVES) {
      const k = 2n + rngBelow(rng, 5n);
      const parts = [];
      let rest = stake;
      for (let j = 0n; j < k; j++) {
        const st = j === k - 1n ? rest : stake / k;
        rest -= j === k - 1n ? 0n : stake / k;
        const tgt = MIN_TARGET_BPS + rngBelow(rng, crash - MIN_TARGET_BPS + 1n);
        parts.push({ stake: st, targetBps: tgt });
      }
      const topLock = parts.reduce((a, p) => (p.targetBps > a ? p.targetBps : a), 0n);
      const { gain, survivors } = gainOf(others, stake, topLock, parts, crash, seed, reserve);
      record("S3-multi-target", gain, survivors, `t=${t}`);
    }
  }
}

// ── S4 multi-wallet under a BINDING global cap (the removed exploit) ──
{
  for (let t = 0; t < 200; t++) {
    const others = [{ id: "o0", stake: E(1), targetBps: 15_000n }];
    const crash = 400_000n;
    const m = 20_000n + rngBelow(rng, 100_000n);
    const stake = 20n + rngBelow(rng, E(50));
    const seed = E(5); // huge seed vs tiny reserve => cap binds hard
    const reserve = E(1);
    for (let k = 2n; k <= 20n; k++) {
      const parts = [];
      let rest = stake;
      for (let j = 1n; j < k; j++) {
        parts.push({ stake: stake / k, targetBps: m });
        rest -= stake / k;
      }
      parts.push({ stake: rest, targetBps: m });
      const { gain, survivors } = gainOf(others, stake, m, parts.filter((p) => p.stake > 0n), crash, seed, reserve);
      record("S4-multi-wallet-binding-cap", gain, survivors, `t=${t} k=${k}`);
    }
  }
}

const totalCases = Object.values(results).reduce((a, r) => a + r.cases, 0);
const worst = Object.values(results).reduce((a, r) => {
  const g = BigInt(r.worstGainWei);
  return g > a ? g : a;
}, -(10n ** 30n));
const out = {
  seed: "20260831",
  acceptance: "aggregate house-bonus gain of ANY partition <= survivorCount wei (rounding dust)",
  totalCases,
  worstGainWeiAcrossAllSearches: worst.toString(),
  failures,
  searches: results,
};
writeFileSync(new URL("./partition-results.json", import.meta.url), JSON.stringify(out, null, 2));
for (const [name, r] of Object.entries(results)) {
  console.log(`${name}: ${r.cases} cases, worst aggregate gain ${r.worstGainWei} wei`);
}
console.log(`\npartition searches: ${totalCases} cases, worst gain ${worst} wei, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
