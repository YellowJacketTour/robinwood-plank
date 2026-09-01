/**
 * Standalone settlement engine mirroring lib/casino/economics.ts, plus the
 * NEW "ladder" (Performance Ladder Settlement, PLS) allocation rule.
 *
 * All amounts and multipliers are integers (bigint). 1.00x == 10_000 bps.
 * Deterministic: no floating point anywhere (integer fixed-point ln).
 */

export const BPS = 10_000n;
export const MIN_TARGET_BPS = 10_100n;

/** ln fixed-point scale: lnScaled(m) ~= ln(m/1e4) * LN_SCALE */
export const LN_SCALE = 1_000_000n;

// ---------------------------------------------------------------------------
// Deterministic integer natural log.
// lnScaled(xBps) = round-ish( ln(xBps/10_000) * LN_SCALE ), xBps >= 10_000.
// Method: normalize x into [1,2) in Q96, extract 40 binary fraction digits of
// log2 by repeated squaring, then multiply by ln(2).
// ---------------------------------------------------------------------------
const Q = 96n;
const ONE_Q = 1n << Q;
const TWO_Q = 2n << Q;
const LN2_SCALED = 693_147n; // ln(2) * 1e6, floor

export function lnScaled(xBps) {
  if (xBps < BPS) throw new RangeError("lnScaled domain: x >= 1.00x");
  if (xBps === BPS) return 0n;
  let z = (xBps << Q) / BPS; // Q96 fixed point, z >= 1
  let k = 0n;
  while (z >= TWO_Q) {
    z >>= 1n;
    k += 1n;
  }
  // z in [1,2). Extract 40 fraction bits of log2(z).
  let frac = 0n; // Q40 fraction of log2
  for (let i = 0n; i < 40n; i++) {
    z = (z * z) >> Q;
    frac <<= 1n;
    if (z >= TWO_Q) {
      frac |= 1n;
      z >>= 1n;
    }
  }
  // log2(x) = k + frac/2^40 ; ln(x) = log2(x) * ln2
  const log2Scaled = k * (1n << 40n) + frac; // Q40
  return (log2Scaled * LN2_SCALED) >> 40n; // scaled by LN_SCALE
}

// ---------------------------------------------------------------------------
// Shared plumbing (mirrors economics.ts)
// ---------------------------------------------------------------------------
function assertInputs(distributable, crashBps, seats) {
  if (distributable < 0n) throw new RangeError("negative distributable");
  if (crashBps < BPS) throw new RangeError("crash below 1.00x");
  const ids = new Set();
  for (const seat of seats) {
    if (!seat.id) throw new RangeError("empty seat id");
    if (ids.has(seat.id)) throw new RangeError(`duplicate seat id: ${seat.id}`);
    ids.add(seat.id);
    if (seat.stake <= 0n) throw new RangeError(`non-positive stake: ${seat.id}`);
    if (seat.targetBps < MIN_TARGET_BPS) throw new RangeError(`target below minimum: ${seat.id}`);
  }
}

function proRata(pool, numerators, denominator) {
  if (pool === 0n || denominator === 0n) return numerators.map(() => 0n);
  return numerators.map((n) => (pool * n) / denominator);
}

export const DEFAULT_LADDER = Object.freeze({
  floorBps: 7_500n, // f: safety-floor fraction of stake
  aBps: 800n, // a: bonus slope per ln-unit, in bps of stake
  hMaxBps: 3_000n, // h_max: bonus ceiling, in bps of stake
});

/** Bonus curve h(m) = min(h_max, a * ln(m)), in bps of stake. Bounded, concave. */
export function bonusBps(targetBps, params) {
  const h = (params.aBps * lnScaled(targetBps)) / LN_SCALE;
  return h < params.hMaxBps ? h : params.hMaxBps;
}

// ---------------------------------------------------------------------------
// settleParimutuel: rules "stake-multiplier" | "stake-only" | "pfss" | "ladder"
// ---------------------------------------------------------------------------
export function settleParimutuel(rule, distributable, crashBps, seats, ladderParams = DEFAULT_LADDER) {
  assertInputs(distributable, crashBps, seats);

  const survived = seats.map((s) => s.targetBps <= crashBps);
  const survivorStake = seats.reduce((sum, s, i) => sum + (survived[i] ? s.stake : 0n), 0n);
  const allBust = survivorStake === 0n;

  let payouts = seats.map(() => 0n);
  let meta = {};

  if (!allBust) {
    if (rule === "pfss") {
      const basePool = distributable < survivorStake ? distributable : survivorStake;
      const surplusPool = distributable - basePool;
      const bases = proRata(
        basePool,
        seats.map((s, i) => (survived[i] ? s.stake : 0n)),
        survivorStake,
      );
      const riskWeights = seats.map((s, i) => (survived[i] ? s.stake * (s.targetBps - BPS) : 0n));
      const totalWeight = riskWeights.reduce((a, b) => a + b, 0n);
      const surpluses = proRata(surplusPool, riskWeights, totalWeight);
      payouts = bases.map((b, i) => b + surpluses[i]);
      meta = { basePool, surplusPool, totalWeight };
    } else if (rule === "stake-only" || rule === "stake-multiplier") {
      const weights = seats.map((s, i) => {
        if (!survived[i]) return 0n;
        return rule === "stake-only" ? s.stake : s.stake * s.targetBps;
      });
      const totalWeight = weights.reduce((a, b) => a + b, 0n);
      payouts = proRata(distributable, weights, totalWeight);
      meta = { totalWeight };
    } else if (rule === "ladder") {
      ({ payouts, meta } = ladder(distributable, seats, survived, survivorStake, ladderParams));
    } else {
      throw new RangeError(`unknown rule: ${rule}`);
    }
  }

  const allocations = seats.map((s, i) => ({
    id: s.id,
    survived: survived[i],
    stake: s.stake,
    targetBps: s.targetBps,
    payout: payouts[i],
    net: payouts[i] - s.stake,
  }));
  const totalPayout = allocations.reduce((sum, a) => sum + a.payout, 0n);
  const vaultRemainder = distributable - totalPayout;
  if (totalPayout > distributable || vaultRemainder < 0n) throw new Error("conservation failure");

  return {
    rule,
    distributable,
    crashBps,
    survivorStake,
    totalPayout,
    vaultRemainder,
    allBust,
    allocations,
    meta,
  };
}

// ---------------------------------------------------------------------------
// Performance Ladder Settlement (PLS)
//
// Stage 1  Floors:    F_i = min(f*s_i, D*s_i/S)          (survivors only)
// Stage 2  Purse:     Q = D - sum(F_i)
// Stage 3  Buckets:   group survivors by identical accepted targetBps,
//                     ordered highest target first. Within a bucket every
//                     allocation is proportional to stake (split-neutral).
// Stage 4  Descend:   for each bucket, (a) top-up floor -> full principal;
//                     if fully restored, (b) pay bonus s_i*h(m)/BPS, both
//                     capped by remaining Q. Unfilled target = unpaid claim.
// Stage 5  Residual:  remaining Q spread by w_i = s_i*ln(m_i), each seat
//                     capped at its lock ceiling s_i*m_i/BPS. Excess -> vault.
// ---------------------------------------------------------------------------
function ladder(distributable, seats, survived, survivorStake, params) {
  const n = seats.length;
  const paid = seats.map(() => 0n);

  // Stage 1: floors
  for (let i = 0; i < n; i++) {
    if (!survived[i]) continue;
    const a = (params.floorBps * seats[i].stake) / BPS;
    const b = (distributable * seats[i].stake) / survivorStake;
    paid[i] = a < b ? a : b;
  }
  let spent = paid.reduce((x, y) => x + y, 0n);
  let purse = distributable - spent;
  if (purse < 0n) throw new Error("floor over-allocation");
  const purseAfterFloors = purse;

  // Stage 3: buckets by target, descending
  const byTarget = new Map();
  for (let i = 0; i < n; i++) {
    if (!survived[i]) continue;
    const key = seats[i].targetBps.toString();
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(i);
  }
  const bucketTargets = [...byTarget.keys()].map((k) => BigInt(k)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  // Stage 4: descend — principal top-up then bonus, per bucket
  const qualified = new Set(); // bucket targets fully restored to principal
  for (const target of bucketTargets) {
    const members = byTarget.get(target.toString());
    // (a) principal top-up
    const deficits = members.map((i) => seats[i].stake - paid[i]);
    const deficitSum = deficits.reduce((a, b) => a + b, 0n);
    if (deficitSum > 0n) {
      if (purse >= deficitSum) {
        members.forEach((i, j) => {
          paid[i] += deficits[j];
        });
        purse -= deficitSum;
      } else {
        const shares = proRata(purse, deficits, deficitSum);
        let used = 0n;
        members.forEach((i, j) => {
          paid[i] += shares[j];
          used += shares[j];
        });
        purse -= used;
        continue; // bucket not fully restored: no bonus, and lower buckets get at most dust
      }
    }
    qualified.add(target.toString());
    // (b) bonus
    if (purse > 0n) {
      const h = bonusBps(target, params);
      const bonuses = members.map((i) => (seats[i].stake * h) / BPS);
      const bonusSum = bonuses.reduce((a, b) => a + b, 0n);
      if (bonusSum > 0n) {
        if (purse >= bonusSum) {
          members.forEach((i, j) => {
            paid[i] += bonuses[j];
          });
          purse -= bonusSum;
        } else {
          const shares = proRata(purse, bonuses, bonusSum);
          let used = 0n;
          members.forEach((i, j) => {
            paid[i] += shares[j];
            used += shares[j];
          });
          purse -= used;
        }
      }
    }
  }

  // Stage 5: residual by continuous performance score, capped at lock ceiling
  if (purse > 0n) {
    for (let pass = 0; pass < 8 && purse > 0n; pass++) {
      const idx = [];
      const weights = [];
      for (let i = 0; i < n; i++) {
        if (!survived[i]) continue;
        const ceiling = (seats[i].stake * seats[i].targetBps) / BPS;
        if (paid[i] >= ceiling) continue;
        idx.push(i);
        weights.push(seats[i].stake * lnScaled(seats[i].targetBps));
      }
      const wSum = weights.reduce((a, b) => a + b, 0n);
      if (wSum === 0n || idx.length === 0) break;
      const shares = proRata(purse, weights, wSum);
      let used = 0n;
      idx.forEach((i, j) => {
        const ceiling = (seats[i].stake * seats[i].targetBps) / BPS;
        const room = ceiling - paid[i];
        const give = shares[j] < room ? shares[j] : room;
        paid[i] += give;
        used += give;
      });
      if (used === 0n) break;
      purse -= used;
    }
  }
  // Whatever is left in `purse` is dust / ceiling excess -> vault remainder.

  return { payouts: paid, meta: { purseAfterFloors, qualifiedBuckets: [...qualified] } };
}
