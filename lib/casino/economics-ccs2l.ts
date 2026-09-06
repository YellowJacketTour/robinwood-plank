/**
 * "ccs-2l" — Two-Layer Continuous Capped Settlement (variant A, CANONICAL).
 *
 * INTEGRATED on branch integrate/ccs2l-settlement: "ccs-2l" is a selectable
 * AllocationRule in lib/casino/economics.ts and dispatchable from
 * lib/casino/simulation.ts. The live playtest default allocationRule remains
 * "pfss" (lib/playtest-room-core.ts) — ccs-2l is selectable, not default.
 * Evidence: docs/marketplank/sim-settlement-ccs2l/ and
 * DESIGN-PLANKCRASH-CCS2L-INTEGRATION-2026-08-31.md. Variant C (forward-seed
 * recycling) is REJECTED and archived as evidence only; it is not a rule.
 *
 * Mechanism (the player-pot/seed separation, settled on-chain by
 * contracts/PlankCrash.sol via contracts/lib/PlankCcs2LMath.sol, with
 * continuous hazard pricing on the player layer):
 *
 * PLAYER LAYER — D_players = playerPool - rake. When any survivor exists it is
 * distributed 100% to survivors: p_i = f*s_i/BPS + premium*w_i/W with
 * w_i = s_i * lnScaled(m_i) (the cumulative hazard of _deriveCrash's
 * inverse-uniform law), premium = D_players - sum(floors); integer residue
 * (< survivorCount wei) goes to the largest-weight survivor so the sum is
 * EXACT. No house cap ever touches this layer.
 *
 * HOUSE LAYER (v2, PARTITION-INVARIANT + ACTUARIAL) — the available house purse
 * H_avail = min(H, reserveAtLock*houseCapBps/BPS, rakeWei*houseRakeCapBps/BPS)
 * (GLOBAL caps; the rake cap is the actuarial identity of
 * docs/marketplank/RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md:
 * a round never draws more house money than a fraction of its own rake, never
 * per-address) is split by the house weight w_i = s_i*lnScaled(m_i) — linear
 * in stake and identity-independent — and capped per seat only at the
 * fair-odds cap s_i*(m_i-BPS)/BPS (linear in stake, additive under wallet
 * splits). Every constraint is positively homogeneous in stake, so splitting
 * one economic position across wallets cannot raise the aggregate house bonus
 * beyond deterministic rounding dust (proven exhaustively in
 * docs/marketplank/sim-settlement-ccs2l/partition.mjs). The former per-WALLET
 * reserveAtLock*singlePayoutCapBps cap (constant per address, split-relaxable)
 * is REMOVED; its protective role is carried by the global H_avail cap. The
 * unused remainder returns to the protected reserve. Never to players' rake
 * ledger, never to treasury.
 *
 * NO SURVIVOR — the separately-ratified busted-round allocation: the whole
 * distributable returns to the reserve.
 *
 * The 40/40/20 ratified split applies ONLY to actual rake; there is no
 * player-pot cap residue in this rule, structurally.
 */

import { BPS, MIN_TARGET_BPS, type Seat } from "./economics";

export const CCS2L_LAMBDA_DENOM = 1_000_000_000_000_000_000n;
export const CCS2L_MAX_STAKE = 10n ** 30n;
export const CCS2L_MAX_TARGET = 10n ** 9n;
export const CCS2L_MAX_POT = 10n ** 33n;

export type Ccs2LPlayerWeight = "ln" | "odds";

export interface Ccs2LParams {
  /** Min survivor recovery fraction of stake, bps (provisionally 7_500). */
  floorBps: bigint;
  /** "ln" = variant A (hazard-calibrated, CANONICAL); "odds" = variant B dial. */
  playerWeight: Ccs2LPlayerWeight;
  /** GLOBAL aggregate house-purse cap as bps of reserveAtLock (never per-address). */
  houseCapBps: bigint;
  /** GLOBAL aggregate house-purse cap as bps of the round's OWN rake (v2 actuarial identity). */
  houseRakeCapBps: bigint;
  /**
   * v3 PARTICIPATION-COUNT VAULT BONUS (docs/marketplank/SPEC-monotonic-
   * vault-positive-sum-2026-09-05.md). An ADDITIONAL cap on hAvail, keyed to
   * how many rounds have EVER contributed to the vault -- never to the
   * vault's own balance. 0 = feature off (backward-compatible default).
   * Ceiling, bps of the round's rake (ratified 2_500 = 25%).
   */
  maxVaultBonusBps: bigint;
  /** r, WAD-scaled (1e18 == 1.0; ratified 0.999e18). Must be 0 < r < 1e18 whenever maxVaultBonusBps > 0. */
  vaultBonusDecayWad: bigint;
}

export const DEFAULT_CCS2L_PARAMS: Ccs2LParams = {
  floorBps: 7_500n,
  playerWeight: "ln",
  houseCapBps: 1_000n,
  houseRakeCapBps: 5_000n,
  maxVaultBonusBps: 0n,
  vaultBonusDecayWad: 0n,
};

export interface Ccs2LAllocation {
  id: string;
  survived: boolean;
  stake: bigint;
  targetBps: bigint;
  playerPayout: bigint;
  /**
   * Telemetry decomposition of playerPayout (floorPayout + performancePayout
   * === playerPayout, exactly). In "normal" mode floorPayout is the ratified
   * f·s_i/BPS survivor floor and performancePayout is the hazard-weighted
   * premium share plus any conservation dust; in "floor-degenerate" mode the
   * whole prorated payment is floor-derived. Purely additive reporting —
   * payout arithmetic is untouched.
   */
  floorPayout: bigint;
  performancePayout: bigint;
  houseBonus: bigint;
  payout: bigint;
  net: bigint;
}

export interface Ccs2LSettlement {
  rule: "ccs-2l";
  playerDistributable: bigint;
  seedH: bigint;
  crashBps: bigint;
  survivorStake: bigint;
  allBust: boolean;
  totalPlayerPaid: bigint;
  totalBonus: bigint;
  totalPayout: bigint;
  /** Unused seed -> PROTECTED RESERVE (never players, never treasury). */
  houseReturned: bigint;
  /** No-survivor rounds: whole distributable -> reserve (ratified routing). */
  bustedToReserve: bigint;
  /** Structural zero: this rule has no player-pot cap residue. */
  treasuryCapResidue: 0n;
  allocations: Ccs2LAllocation[];
  meta: { mode: "no-survivor" | "floor-degenerate" | "normal"; lambda: bigint; playerDust: bigint; dustIndex: number };
}

/** Deterministic fixed-point ln: lnScaled(xBps) ~= ln(x/1e4)*1e6, floor. */
export function lnScaled(xBps: bigint): bigint {
  if (xBps < BPS) throw new RangeError("lnScaled domain: x >= 1.00x");
  if (xBps === BPS) return 0n;
  const Q = 96n;
  const TWO_Q = 2n << Q;
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
  return ((k * (1n << 40n) + frac) * 693_147n) >> 40n;
}

/**
 * Fixed-point r^n at WAD (1e18) precision via exponentiation by squaring --
 * exact mirror of PlankCcs2LMath.powWad. Verified 2026-09-05: a 1e6/ppm scale
 * drifts up to ~2.6% by n=10,000; WAD is exact to integer-division rounding
 * at every scale tested.
 */
export function powWad(baseWad: bigint, exponent: bigint): bigint {
  let result = CCS2L_LAMBDA_DENOM; // 1.0 in WAD
  let b = baseWad;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) / CCS2L_LAMBDA_DENOM;
    b = (b * b) / CCS2L_LAMBDA_DENOM;
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
export function vaultBonusBps(maxVaultBonusBpsValue: bigint, vaultBonusDecayWad: bigint, roundsContributed: bigint): bigint {
  if (maxVaultBonusBpsValue === 0n) return 0n;
  const rn = powWad(vaultBonusDecayWad, roundsContributed);
  return (maxVaultBonusBpsValue * (CCS2L_LAMBDA_DENOM - rn)) / CCS2L_LAMBDA_DENOM;
}

function playerG(targetBps: bigint, playerWeight: Ccs2LPlayerWeight): bigint {
  return playerWeight === "odds" ? targetBps - BPS : lnScaled(targetBps);
}

function assertInputs(playerDistributable: bigint, seedH: bigint, crashBps: bigint, seats: readonly Seat[]): void {
  if (playerDistributable < 0n || playerDistributable > CCS2L_MAX_POT) throw new RangeError("bad player pot");
  if (seedH < 0n || seedH > CCS2L_MAX_POT) throw new RangeError("bad seed");
  if (crashBps < BPS) throw new RangeError("crash below 1.00x");
  const ids = new Set<string>();
  for (const s of seats) {
    if (!s.id) throw new RangeError("empty seat id");
    if (ids.has(s.id)) throw new RangeError(`duplicate seat id: ${s.id}`);
    ids.add(s.id);
    if (s.stake <= 0n || s.stake > CCS2L_MAX_STAKE) throw new RangeError(`bad stake: ${s.id}`);
    if (s.targetBps < MIN_TARGET_BPS || s.targetBps > CCS2L_MAX_TARGET) throw new RangeError(`bad target: ${s.id}`);
  }
}

/**
 * Settle one round under CCS-2L. Reads ONLY current-round inputs.
 * Wei-for-wei identical to docs/marketplank/sim-settlement-ccs2l/engine.mjs
 * and (variant A) to contracts/test/PlankCcs2LSettlement.sol.
 */
export function settleCcs2L(
  playerDistributable: bigint,
  seedH: bigint,
  crashBps: bigint,
  seats: readonly Seat[],
  reserveAtLock: bigint,
  params: Ccs2LParams = DEFAULT_CCS2L_PARAMS,
  /**
   * The rake this round leaves behind (net of keeper bounty): the base of the
   * v2 actuarial house cap. The on-chain law ALWAYS applies it; omit it only
   * to replay v1-era records or historical campaigns (no rake cap).
   */
  rakeWei?: bigint,
  /**
   * v3: the live participation counter AT ROUND LOCK (round data, not a rule
   * parameter -- see Ccs2LParams' own docs on why this is a separate
   * argument). Omit to replay pre-v3 records/campaigns, or on a deployment
   * with maxVaultBonusBps == 0 where it has no effect either way.
   */
  vaultRoundsContributed?: bigint,
): Ccs2LSettlement {
  assertInputs(playerDistributable, seedH, crashBps, seats);
  if (reserveAtLock < 0n) throw new RangeError("negative reserve");
  if (rakeWei !== undefined && (rakeWei < 0n || rakeWei > CCS2L_MAX_POT)) throw new RangeError("rake out of range");
  const n = seats.length;
  const survived = seats.map((s) => s.targetBps <= crashBps);
  const survivorStake = seats.reduce((a, s, i) => a + (survived[i] ? s.stake : 0n), 0n);
  const allBust = survivorStake === 0n;

  let playerPaid = seats.map(() => 0n);
  let floorPaid = seats.map(() => 0n);
  const bonuses = seats.map(() => 0n);
  let mode: Ccs2LSettlement["meta"]["mode"] = "no-survivor";
  let lambda = 0n;
  let dustIndex = -1;
  let playerDust = 0n;
  let houseReturned = 0n;
  let bustedToReserve = 0n;

  if (allBust) {
    bustedToReserve = playerDistributable + seedH;
  } else {
    const floors = seats.map((s, i) => (survived[i] ? (params.floorBps * s.stake) / BPS : 0n));
    const ws = seats.map((s, i) => (survived[i] ? s.stake * playerG(s.targetBps, params.playerWeight) : 0n));
    const sumFloors = floors.reduce((a, b) => a + b, 0n);
    const W = ws.reduce((a, b) => a + b, 0n);

    let weightsForDust: bigint[];
    if (sumFloors > playerDistributable) {
      mode = "floor-degenerate";
      playerPaid = floors.map((fl) => (fl > 0n ? (playerDistributable * fl) / sumFloors : 0n));
      floorPaid = playerPaid.slice();
      weightsForDust = floors;
    } else {
      mode = "normal";
      const premium = playerDistributable - sumFloors;
      lambda = W > 0n ? (premium * CCS2L_LAMBDA_DENOM) / W : 0n;
      playerPaid = seats.map((s, i) => (survived[i] ? floors[i] + (premium * ws[i]) / W : 0n));
      floorPaid = floors.slice();
      weightsForDust = ws;
    }
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

    // House layer v1.1 — partition-invariant: global reserve cap + linear caps.
    const reserveCap = (reserveAtLock * params.houseCapBps) / BPS;
    let hAvail = seedH < reserveCap ? seedH : reserveCap;
    // v2 actuarial identity: never more than a fraction of THIS round's rake.
    if (rakeWei !== undefined) {
      const rakeCap = (rakeWei * params.houseRakeCapBps) / BPS;
      if (rakeCap < hAvail) hAvail = rakeCap;
    }
    // v3 participation-count vault bonus (SPEC-monotonic-vault-positive-sum-
    // 2026-09-05 §3.4): an ADDITIONAL cap, narrowing hAvail further toward a
    // ceiling that rises with sustained play, never with vault balance.
    // maxVaultBonusBps === 0n means the feature is OFF (backward-compatible
    // default) -- never treated as "cap everything to zero."
    if (rakeWei !== undefined && vaultRoundsContributed !== undefined && params.maxVaultBonusBps > 0n) {
      const vaultCap = (rakeWei * vaultBonusBps(params.maxVaultBonusBps, params.vaultBonusDecayWad, vaultRoundsContributed)) / BPS;
      if (vaultCap < hAvail) hAvail = vaultCap;
    }
    const hws = seats.map((s, i) => (survived[i] ? s.stake * lnScaled(s.targetBps) : 0n));
    const HW = hws.reduce((a, b) => a + b, 0n);
    let bSum = 0n;
    if (hAvail > 0n && HW > 0n) {
      for (let i = 0; i < n; i++) {
        if (!survived[i]) continue;
        const bRaw = (hAvail * hws[i]) / HW;
        const fairCap = (seats[i].stake * (seats[i].targetBps - BPS)) / BPS;
        bonuses[i] = bRaw < fairCap ? bRaw : fairCap;
        bSum += bonuses[i];
      }
    }
    houseReturned = seedH - bSum;
    if (houseReturned < 0n) throw new Error("house layer overpaid");
  }

  const allocations = seats.map<Ccs2LAllocation>((s, i) => ({
    id: s.id,
    survived: survived[i],
    stake: s.stake,
    targetBps: s.targetBps,
    playerPayout: playerPaid[i],
    floorPayout: floorPaid[i],
    performancePayout: playerPaid[i] - floorPaid[i],
    houseBonus: bonuses[i],
    payout: playerPaid[i] + bonuses[i],
    net: playerPaid[i] + bonuses[i] - s.stake,
  }));

  const totalPlayerPaid = playerPaid.reduce((a, b) => a + b, 0n);
  const totalBonus = bonuses.reduce((a, b) => a + b, 0n);
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
    houseReturned,
    bustedToReserve,
    treasuryCapResidue: 0n,
    allocations,
    meta: { mode, lambda, playerDust, dustIndex },
  };
}
