/**
 * Continuous Capped Settlement (CCS) — exact bigint reference engine.
 *
 * CCS is the 4th allocation rule ("ccs") for lib/casino/economics.ts's
 * pluggable settleParimutuel. This file is the analysis/differential oracle;
 * it must stay wei-for-wei identical to contracts/test/PlankCcsSettlement.sol.
 *
 * Mechanism (survivor i, survived iff targetBps_i <= crashBps):
 *   floor_i = f * s_i / BPS                          (integer floor division)
 *   g_i     = lnScaled(m_i)                          (fixed-point ln, 1e6 scale)
 *   c_i     = s_i * min(m_i, CEIL_MULT_BPS) / BPS    (disclosed payout cap)
 *   p_i(l)  = min(c_i, floor_i + l*s_i*g_i / DENOM)  (DENOM = 1e18)
 *   l (lambda) = largest integer with sum p_i(l) <= D, found by exact
 *   bisection over [0, 2^90] in exactly 90 halvings. Residual D - P(l) is
 *   integer dust -> Vault.
 *
 * Feasibility branches (checked in this order):
 *   allBust      : no survivor            -> D to Vault.
 *   cap-excess   : sum(c_i) <= D          -> every survivor paid c_i exactly;
 *                  capExcess = D - sum(c_i) routed through the RATIFIED
 *                  20/40/40 split (burn/community/founders), NOT to Vault.
 *   floor-scaled : sum(floor_i) > D       -> floors scaled pro-rata:
 *                  p_i = D * floor_i / sum(floor_i) (pure-parimutuel
 *                  degenerate; floors are linear in stake so this equals
 *                  stake-pro-rata up to dust).
 *   interior     : bisection as above.
 *
 * All amounts/multipliers are integers. 1.00x == 10_000 bps. No floats.
 */

export const BPS = 10_000n;
export const MIN_TARGET_BPS = 10_100n;
export const LN_SCALE = 1_000_000n;
export const LAMBDA_DENOM = 1_000_000_000_000_000_000n; // 1e18 = LN_SCALE * 1e12
export const LAMBDA_BITS = 90n; // bisection domain [0, 2^90], exactly 90 halvings
export const DEFAULT_CCS = Object.freeze({
  floorBps: 7_500n, // f: min survivor recovery fraction
  ceilMultBps: 500_000n, // global payout-cap multiplier (50.00x)
});

// ---------------------------------------------------------------------------
// Deterministic integer natural log (identical to sim-settlement/engine.mjs
// and to PlankCcsSettlement.lnScaled). lnScaled(xBps) ~ ln(x/1e4)*1e6, floor.
// ---------------------------------------------------------------------------
const Q = 96n;
const TWO_Q = 2n << Q;
const LN2_SCALED = 693_147n;

export function lnScaled(xBps) {
  if (xBps < BPS) throw new RangeError("lnScaled domain: x >= 1.00x");
  if (xBps === BPS) return 0n;
  let z = (xBps << Q) / BPS;
  let k = 0n;
  while (z >= TWO_Q) {
    z >>= 1n;
    k += 1n;
  }
  let frac = 0n;
  for (let i = 0n; i < 40n; i++) {
    z = (z * z) >> Q;
    frac <<= 1n;
    if (z >= TWO_Q) {
      frac |= 1n;
      z >>= 1n;
    }
  }
  const log2Scaled = k * (1n << 40n) + frac;
  return (log2Scaled * LN2_SCALED) >> 40n;
}

// ---------------------------------------------------------------------------
function assertInputs(distributable, crashBps, seats) {
  if (distributable < 0n) throw new RangeError("negative distributable");
  if (crashBps < BPS) throw new RangeError("crash below 1.00x");
  const ids = new Set();
  for (const s of seats) {
    if (!s.id) throw new RangeError("empty seat id");
    if (ids.has(s.id)) throw new RangeError(`duplicate seat id: ${s.id}`);
    ids.add(s.id);
    if (s.stake <= 0n) throw new RangeError(`non-positive stake: ${s.id}`);
    if (s.stake > 10n ** 30n) throw new RangeError(`stake overflow bound: ${s.id}`);
    if (s.targetBps < MIN_TARGET_BPS) throw new RangeError(`target below minimum: ${s.id}`);
    if (s.targetBps > 10n ** 9n) throw new RangeError(`target overflow bound: ${s.id}`);
  }
}

/** min survivor cap. Published pre-commit: c = s * min(m, CEIL) / BPS. */
export function seatCap(stake, targetBps, params) {
  const m = targetBps < params.ceilMultBps ? targetBps : params.ceilMultBps;
  return (stake * m) / BPS;
}

/** p_i at a given lambda. */
function paidAt(lambda, floor_, stake, g, cap) {
  const p = floor_ + (lambda * stake * g) / LAMBDA_DENOM;
  return p < cap ? p : cap;
}

/**
 * Settle one round under CCS. Returns the same shape as the PLS engine plus
 * meta: { mode, lambda, sumFloors, sumCaps, capExcess, capExcessSplit }.
 */
export function settleCcs(distributable, crashBps, seats, params = DEFAULT_CCS) {
  assertInputs(distributable, crashBps, seats);
  const n = seats.length;
  const survived = seats.map((s) => s.targetBps <= crashBps);
  const survivorStake = seats.reduce((a, s, i) => a + (survived[i] ? s.stake : 0n), 0n);
  const allBust = survivorStake === 0n;

  let payouts = seats.map(() => 0n);
  let mode = "all-bust";
  let lambda = 0n;
  let sumFloors = 0n;
  let sumCaps = 0n;
  let capExcess = 0n;

  const floors = seats.map((s, i) => (survived[i] ? (params.floorBps * s.stake) / BPS : 0n));
  const caps = seats.map((s, i) => (survived[i] ? seatCap(s.stake, s.targetBps, params) : 0n));
  const gs = seats.map((s, i) => (survived[i] ? lnScaled(s.targetBps) : 0n));
  sumFloors = floors.reduce((a, b) => a + b, 0n);
  sumCaps = caps.reduce((a, b) => a + b, 0n);

  if (!allBust) {
    if (sumCaps <= distributable) {
      mode = "cap-excess";
      payouts = caps.slice();
      capExcess = distributable - sumCaps;
    } else if (sumFloors > distributable) {
      mode = "floor-scaled";
      payouts = floors.map((fl) => (distributable * fl) / sumFloors);
    } else {
      mode = "interior";
      // exact bisection: largest lambda in [0, 2^LAMBDA_BITS] with P(lambda) <= D
      const total = (l) => {
        let t = 0n;
        for (let i = 0; i < n; i++) {
          if (!survived[i]) continue;
          t += paidAt(l, floors[i], seats[i].stake, gs[i], caps[i]);
        }
        return t;
      };
      let lo = 0n;
      let hi = 1n << LAMBDA_BITS; // P(hi) = sumCaps > D guaranteed (see doc)
      for (let iter = 0n; iter < LAMBDA_BITS; iter++) {
        const mid = (lo + hi) >> 1n;
        if (total(mid) <= distributable) lo = mid;
        else hi = mid;
      }
      lambda = lo;
      for (let i = 0; i < n; i++) {
        if (!survived[i]) continue;
        payouts[i] = paidAt(lambda, floors[i], seats[i].stake, gs[i], caps[i]);
      }
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
  const totalPayout = allocations.reduce((a, x) => a + x.payout, 0n);
  // Cap excess is NOT vault dust: it routes through the ratified split.
  const vaultRemainder = distributable - totalPayout - capExcess;
  if (totalPayout + capExcess > distributable || vaultRemainder < 0n) {
    throw new Error("conservation failure");
  }
  const capExcessSplit = ratifiedSplit(capExcess);

  return {
    rule: "ccs",
    distributable,
    crashBps,
    survivorStake,
    totalPayout,
    vaultRemainder,
    capExcess,
    capExcessSplit,
    allBust,
    allocations,
    meta: { mode, lambda, sumFloors, sumCaps },
  };
}

/** Ratified one-pass 20/40/40 split (mirrors economics.ts ratifiedRakeSplit, keeper=0). */
export function ratifiedSplit(amount) {
  if (amount < 0n) throw new RangeError("negative split amount");
  const burn = (amount * 2_000n) / BPS;
  const community = (amount * 4_000n) / BPS;
  const founders = amount - burn - community;
  return { burn, community, founders };
}

/** Round funding identical to economics.ts roundEconomics. */
export function roundEconomics(seed, stakes, rakeBps) {
  const playerPool = stakes.reduce((a, b) => a + b, 0n);
  const playerDistributable = (playerPool * (BPS - rakeBps)) / BPS;
  return {
    seed,
    playerPool,
    rake: playerPool - playerDistributable,
    distributable: seed + playerDistributable,
  };
}

// ---------------------------------------------------------------------------
// Crash distribution: exact mirror of PlankCrashDrand._deriveCrash.
// r uniform in [0,10000); r==0 -> 1.00x instant bust; else 1e8/(10000-r) bps.
// Survival law: P(crash >= m) = 1/m exactly on the grid; cumulative hazard
// H(m) = ln(m) — the calibration basis for g = ln.
// ---------------------------------------------------------------------------
export function deriveCrashBps(r) {
  if (r < 0n || r >= 10_000n) throw new RangeError("r out of range");
  if (r === 0n) return 10_000n;
  return (10_000n * 10_000n) / (10_000n - r);
}

/** splitmix64 — deterministic seedable PRNG over bigint. */
export function makeRng(seed) {
  let state = BigInt.asUintN(64, seed);
  return () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
}

export function rngBelow(rng, bound) {
  // modulo bias negligible for bound << 2^64 and irrelevant to invariants
  return rng() % bound;
}
