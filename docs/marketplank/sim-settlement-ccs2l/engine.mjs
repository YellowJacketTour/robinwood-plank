/**
 * CCS-2L — Two-Layer Continuous Capped Settlement. Exact bigint reference.
 *
 * REJECTS the single-purse CCS (docs/marketplank/sim-settlement-ccs): its
 * per-seat cap c_i = s_i*m_i confiscated PLAYER-funded parimutuel value into
 * the treasury split (aggregate RTP 57.5%). Root cause: it capped player money
 * to protect the house. CCS-2L mirrors the on-chain _splitPayout separation of
 * playerPot vs seed, with continuous hazard pricing on the player layer:
 *
 * LAYER 1 — PLAYER (D_players = playerPool - rake, i.e. floor((1-r)*stakes)):
 *   When ANY survivor exists, 100% of D_players goes to survivors:
 *     floor_i   = f * s_i / BPS
 *     w_i       = s_i * g(m_i)          (variant A: g = lnScaled, the
 *                                        cumulative hazard of _deriveCrash;
 *                                        variant B: g = m - BPS, odds-linear)
 *     premium   = D_players - sum(floor_i)   (>= 0 whenever f <= BPS - rake)
 *     p_i       = floor_i + premium * w_i / W
 *   Integer dust (premium - sum of floored shares, < survivorCount wei) is
 *   awarded to the survivor with the LARGEST w_i (lowest index on ties), so
 *   sum(p_i) == D_players EXACTLY. NO house cap ever touches this layer —
 *   a cap must never confiscate player-funded value.
 *   The uncapped clearing has a CLOSED FORM: lambda = premium*1e18/W and
 *   p_i = floor_i + lambda-weighted share. Bisection (single-purse CCS's 90
 *   halvings) is unnecessary because there is no per-seat cap to make P(l)
 *   piecewise; settleCcs2LBisect() exists only as a cross-check.
 *   Defensive branch: if sum(floor_i) > D_players (only possible when
 *   f > BPS - rakeBps), floors are scaled pro-rata with the same exact dust
 *   rule ("floor-degenerate").
 *
 * LAYER 2 — HOUSE (D_house = H, the rolled/committed seed) — PARTITION-INVARIANT
 * v1.1 (2026-08-31): every house-protection constraint is IDENTITY-INDEPENDENT
 * and POSITIVELY HOMOGENEOUS in stake, so splitting one economic position
 * across wallets can never increase the aggregate house bonus beyond
 * deterministic rounding dust:
 *   H_avail = min(H, reserveAtLock*houseCapBps/BPS,   (GLOBAL reserve-at-lock
 *                 rakeWei*houseRakeCapBps/BPS)         cap on the whole purse +
 *                                                      v2 ACTUARIAL rake cap:
 *                                                      never more than a
 *                                                      fraction of this round's
 *                                                      own rake, see RESEARCH-
 *                                                      game-theory-lottery-seed-
 *                                                      resolution-2026-09-05)
 *   w_i     = s_i * lnScaled(m_i)           (house weight — linear in stake,
 *                                            identity-independent)
 *   bRaw_i  = H_avail * w_i / W
 *   b_i     = min(bRaw_i, s_i*(m_i - BPS)/BPS)   (per-seat FAIR-ODDS cap —
 *             linear in stake, additive under splits, so it is a lawful local
 *             cap; the aggregate fair-odds constraint sum(b) <= sum(s*(m-1))
 *             follows)
 *   H_returned = H - sum(b_i)  -> PROTECTED RESERVE (never players/treasury).
 * REMOVED: the per-WALLET reserveAtLock*singlePayoutCapBps cap (constant per
 * address => split-relaxable; N wallets got N caps). Its house-protection role
 * is preserved by the GLOBAL H_avail cap above, which the wallet count cannot
 * change. Partition-invariance is proven exhaustively in partition.mjs.
 *
 * NO SURVIVOR: the separately-ratified busted-round allocation — the whole
 * distributable (player pot AND seed) returns to the reserve. Not new design.
 *
 * total payout_i = p_i + b_i. There is NO cap residue: the 20/40/40 split
 * applies only to actual rake (and designated Powerboard funding), never to
 * player winnings. Settlement reads ONLY current-round inputs.
 *
 * All amounts/multipliers integers; 1.00x == 10_000 bps. No floats.
 */

export const BPS = 10_000n;
export const MIN_TARGET_BPS = 10_100n;
export const LN_SCALE = 1_000_000n;
export const LAMBDA_DENOM = 1_000_000_000_000_000_000n; // 1e18
export const MAX_STAKE = 10n ** 30n;
export const MAX_TARGET = 10n ** 9n;
export const MAX_POT = 10n ** 33n;

export const DEFAULT_CCS2L = Object.freeze({
  floorBps: 7_500n, // f: min survivor recovery fraction of stake (player layer)
  playerWeight: "ln", // "ln" (variant A, CANONICAL) | "odds" (variant B dial)
  houseCapBps: 1_000n, // GLOBAL aggregate house-purse cap, of reserveAtLock
  houseRakeCapBps: 5_000n, // v2 GLOBAL house-purse cap, of the round's own rake
  // v3 participation-count vault bonus (SPEC-monotonic-vault-positive-sum-
  // 2026-09-05): an ADDITIONAL cap on hAvail keyed to a round-count, never a
  // vault balance. 0 = feature off (default here, matching pre-v3 behavior).
  maxVaultBonusBps: 0n,
  vaultBonusDecayWad: 0n,
});

// ---------------------------------------------------------------------------
// Deterministic integer natural log — identical to sim-settlement-ccs/engine.mjs
// and PlankCcs2LSettlement.lnScaled. lnScaled(xBps) ~ ln(x/1e4)*1e6, floor.
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

function assertInputs(playerDistributable, seedH, crashBps, seats) {
  if (playerDistributable < 0n || playerDistributable > MAX_POT) throw new RangeError("bad player pot");
  if (seedH < 0n || seedH > MAX_POT) throw new RangeError("bad seed");
  if (crashBps < BPS) throw new RangeError("crash below 1.00x");
  const ids = new Set();
  for (const s of seats) {
    if (!s.id) throw new RangeError("empty seat id");
    if (ids.has(s.id)) throw new RangeError(`duplicate seat id: ${s.id}`);
    ids.add(s.id);
    if (s.stake <= 0n || s.stake > MAX_STAKE) throw new RangeError(`bad stake: ${s.id}`);
    if (s.targetBps < MIN_TARGET_BPS || s.targetBps > MAX_TARGET) throw new RangeError(`bad target: ${s.id}`);
  }
}

export function playerG(targetBps, playerWeight) {
  return playerWeight === "odds" ? targetBps - BPS : lnScaled(targetBps);
}

/**
 * Fixed-point r^n at WAD (1e18) precision via exponentiation by squaring --
 * exact mirror of PlankCcs2LMath.powWad. Verified 2026-09-05: a 1e6/ppm scale
 * drifts up to ~2.6% by n=10,000; WAD is exact to integer-division rounding
 * at every scale tested.
 */
export function powWad(baseWad, exponent) {
  let result = LAMBDA_DENOM; // 1.0 in WAD
  let b = baseWad;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) / LAMBDA_DENOM;
    b = (b * b) / LAMBDA_DENOM;
    e >>= 1n;
  }
  return result;
}

/**
 * The participation-count vault bonus ceiling for THIS round, in bps of the
 * round's own rake: maxVaultBonusBps * (1 - r^n), the geometric ratchet of
 * SPEC-monotonic-vault-positive-sum's §3.4. Exact mirror of
 * PlankCcs2LMath.vaultBonusBps.
 */
export function vaultBonusBps(maxVaultBonusBps, vaultBonusDecayWad, roundsContributed) {
  if (maxVaultBonusBps === 0n) return 0n;
  const rn = powWad(vaultBonusDecayWad, roundsContributed);
  return (maxVaultBonusBps * (LAMBDA_DENOM - rn)) / LAMBDA_DENOM;
}

/**
 * Settle one round under CCS-2L.
 *
 * @param playerDistributable D_players = playerPool - rake (player money).
 * @param seedH               D_house = the round's rolled/committed seed.
 * @param crashBps            realized crash multiplier.
 * @param seats               [{id, stake, targetBps}] (targetBps = accepted lock).
 * @param reserveAtLock       reserve snapshot for the GLOBAL house-purse cap.
 * @param params              {floorBps, playerWeight, houseCapBps, houseRakeCapBps}.
 * @param rakeWei             the rake this round leaves behind: base of the v2
 *                            actuarial house cap. The chain ALWAYS applies it;
 *                            omitted (undefined) = v1 house layer, kept only so
 *                            the historical campaigns/scenarios still replay.
 * @param vaultRoundsContributed v3: the live participation counter at round
 *                            lock (round data, not a rule parameter). Omitted
 *                            = v2 house layer (no vault bonus), kept only so
 *                            pre-v3 campaigns/scenarios still replay exactly.
 */
export function settleCcs2L(
  playerDistributable,
  seedH,
  crashBps,
  seats,
  reserveAtLock,
  params = DEFAULT_CCS2L,
  rakeWei = undefined,
  vaultRoundsContributed = undefined,
) {
  assertInputs(playerDistributable, seedH, crashBps, seats);
  if (reserveAtLock < 0n) throw new RangeError("negative reserve");
  if (rakeWei !== undefined && (rakeWei < 0n || rakeWei > MAX_POT)) throw new RangeError("rake out of range");
  const n = seats.length;
  const survived = seats.map((s) => s.targetBps <= crashBps);
  const survivorStake = seats.reduce((a, s, i) => a + (survived[i] ? s.stake : 0n), 0n);
  const allBust = survivorStake === 0n;

  let playerPaid = seats.map(() => 0n);
  let bonuses = seats.map(() => 0n);
  let mode = "no-survivor";
  let lambda = 0n;
  let dustIndex = -1;
  let playerDust = 0n;
  let houseReturned = seedH;
  let bustedToReserve = 0n;

  if (allBust) {
    // Separately-ratified busted-round allocation: everything -> reserve,
    // routed EXCLUSIVELY through bustedToReserve (houseReturned stays 0 so
    // no wei is ever double-reported).
    bustedToReserve = playerDistributable + seedH;
    houseReturned = 0n;
  } else {
    // ── LAYER 1: player purse, distributed in full ──────────────────────
    const floors = seats.map((s, i) => (survived[i] ? (params.floorBps * s.stake) / BPS : 0n));
    const ws = seats.map((s, i) => (survived[i] ? s.stake * playerG(s.targetBps, params.playerWeight) : 0n));
    const sumFloors = floors.reduce((a, b) => a + b, 0n);
    const W = ws.reduce((a, b) => a + b, 0n); // > 0: every survivor has m >= 1.01 => g > 0

    let weightsForDust;
    if (sumFloors > playerDistributable) {
      mode = "floor-degenerate"; // reachable only when f > BPS - rakeBps
      playerPaid = floors.map((fl) => (fl > 0n ? (playerDistributable * fl) / sumFloors : 0n));
      weightsForDust = floors;
    } else {
      mode = "normal";
      const premium = playerDistributable - sumFloors;
      lambda = W > 0n ? (premium * LAMBDA_DENOM) / W : 0n; // closed-form clearing price
      playerPaid = seats.map((s, i) => (survived[i] ? floors[i] + (premium * ws[i]) / W : 0n));
      weightsForDust = ws;
    }
    // Exact-conservation dust rule: residue (< survivorCount wei) to the
    // survivor with the largest weight, lowest index on ties. Non-farmable:
    // gain < n wei, and winning the award requires the largest stake-weight.
    const paidSum = playerPaid.reduce((a, b) => a + b, 0n);
    playerDust = playerDistributable - paidSum;
    if (playerDust < 0n) throw new Error("player layer overpaid");
    if (playerDust > 0n) {
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (survived[i] && (best === -1 || weightsForDust[i] > weightsForDust[best])) best = i;
      }
      dustIndex = best;
      playerPaid[best] += playerDust;
    }

    // ── LAYER 2: house purse — partition-invariant (v1.1) ────────────────
    // Global reserve-at-lock cap on the WHOLE purse (identity-independent):
    const reserveCap = (reserveAtLock * params.houseCapBps) / BPS;
    let hAvail = seedH < reserveCap ? seedH : reserveCap;
    // v2 actuarial identity: never more than a fraction of THIS round's rake.
    if (rakeWei !== undefined) {
      const rakeCap = (rakeWei * (params.houseRakeCapBps ?? 0n)) / BPS;
      if (rakeCap < hAvail) hAvail = rakeCap;
    }
    // v3 participation-count vault bonus (SPEC-monotonic-vault-positive-sum-
    // 2026-09-05 §3.4): an ADDITIONAL cap, narrowing hAvail further toward a
    // ceiling that rises with sustained play, never with vault balance.
    if (rakeWei !== undefined && vaultRoundsContributed !== undefined && (params.maxVaultBonusBps ?? 0n) > 0n) {
      const vaultCap = (rakeWei * vaultBonusBps(params.maxVaultBonusBps, params.vaultBonusDecayWad, vaultRoundsContributed)) / BPS;
      if (vaultCap < hAvail) hAvail = vaultCap;
    }
    // House weight: s*lnScaled(m) — linear in stake at fixed m, so additive
    // under any wallet split of the same economic position.
    const hws = seats.map((s, i) => (survived[i] ? s.stake * lnScaled(s.targetBps) : 0n));
    const HW = hws.reduce((a, b) => a + b, 0n); // > 0 whenever a survivor exists
    let bSum = 0n;
    if (hAvail > 0n && HW > 0n) {
      for (let i = 0; i < n; i++) {
        if (!survived[i]) continue;
        const bRaw = (hAvail * hws[i]) / HW;
        // Per-seat FAIR-ODDS cap s*(m-1) — linear in stake, lawful local cap.
        const fairCap = (seats[i].stake * (seats[i].targetBps - BPS)) / BPS;
        bonuses[i] = bRaw < fairCap ? bRaw : fairCap;
        bSum += bonuses[i];
      }
    }
    houseReturned = seedH - bSum;
    if (houseReturned < 0n) throw new Error("house layer overpaid");
  }

  const allocations = seats.map((s, i) => ({
    id: s.id,
    survived: survived[i],
    stake: s.stake,
    targetBps: s.targetBps,
    playerPayout: playerPaid[i],
    houseBonus: bonuses[i],
    payout: playerPaid[i] + bonuses[i],
    net: playerPaid[i] + bonuses[i] - s.stake,
  }));

  const totalPlayerPaid = playerPaid.reduce((a, b) => a + b, 0n);
  const totalBonus = bonuses.reduce((a, b) => a + b, 0n);
  // Layer-exact conservation identities (thrown, not logged):
  if (!allBust && totalPlayerPaid !== playerDistributable) throw new Error("player conservation failure");
  if (!allBust && totalBonus + houseReturned !== seedH) throw new Error("house conservation failure");
  if (allBust && bustedToReserve !== playerDistributable + seedH) throw new Error("bust conservation failure");

  return {
    rule: "ccs-2l",
    playerDistributable,
    seedH,
    crashBps,
    survivorStake,
    allBust,
    totalPlayerPaid,
    totalBonus,
    totalPayout: totalPlayerPaid + totalBonus,
    houseReturned, // -> protected reserve, never players, never treasury
    bustedToReserve, // ratified busted-round routing (all-bust only)
    treasuryCapResidue: 0n, // structural: no player-pot cap residue exists
    allocations,
    meta: { mode, lambda, playerDust, dustIndex },
  };
}

/**
 * Cross-check only: the single-purse CCS-style 90-halving bisection applied to
 * the UNCAPPED player layer. Converges to the same clearing price but leaves
 * grid dust; used to evidence that the closed form supersedes bisection.
 */
export function settleCcs2LBisect(playerDistributable, crashBps, seats, params = DEFAULT_CCS2L) {
  assertInputs(playerDistributable, 0n, crashBps, seats);
  const survived = seats.map((s) => s.targetBps <= crashBps);
  if (!survived.some(Boolean)) return null;
  const floors = seats.map((s, i) => (survived[i] ? (params.floorBps * s.stake) / BPS : 0n));
  const ws = seats.map((s, i) => (survived[i] ? s.stake * playerG(s.targetBps, params.playerWeight) : 0n));
  const sumFloors = floors.reduce((a, b) => a + b, 0n);
  if (sumFloors > playerDistributable) return null;
  const total = (l) =>
    seats.reduce((a, s, i) => (survived[i] ? a + floors[i] + (l * ws[i]) / LAMBDA_DENOM : a), 0n);
  let lo = 0n;
  let hi = 1n << 90n;
  if (total(hi) <= playerDistributable) return { lambda: hi, payouts: null, dust: null, saturated: true };
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) >> 1n;
    if (total(mid) <= playerDistributable) lo = mid;
    else hi = mid;
  }
  const payouts = seats.map((s, i) => (survived[i] ? floors[i] + (lo * ws[i]) / LAMBDA_DENOM : 0n));
  const dust = playerDistributable - payouts.reduce((a, b) => a + b, 0n);
  return { lambda: lo, payouts, dust, saturated: false };
}

/** Round funding identical to economics.ts roundEconomics. */
export function roundEconomics(seed, stakes, rakeBps) {
  const playerPool = stakes.reduce((a, b) => a + b, 0n);
  const playerDistributable = (playerPool * (BPS - rakeBps)) / BPS;
  return {
    seed,
    playerPool,
    rake: playerPool - playerDistributable,
    playerDistributable,
    distributable: seed + playerDistributable,
  };
}

/** Ratified one-pass 20/40/40 split — applies ONLY to actual rake. */
export function ratifiedSplit(amount) {
  if (amount < 0n) throw new RangeError("negative split amount");
  const burn = (amount * 2_000n) / BPS;
  const community = (amount * 4_000n) / BPS;
  const founders = amount - burn - community;
  return { burn, community, founders };
}

// Crash law: exact mirror of PlankCrashDrand._deriveCrash.
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
  return rng() % bound;
}
