/**
 * Exact, side-effect-free reference economics for Plank's bounded
 * pari-mutuel crash design. This is an analysis/differential-test oracle,
 * not production settlement code.
 *
 * All amounts and multipliers are integers. 1.00x == 10_000 bps.
 */

export const BPS = 10_000n;
export const MIN_TARGET_BPS = 10_100n;

export type AllocationRule = "stake-multiplier" | "stake-only" | "pfss" | "ccs-2l";

// "ccs-2l" is settled by settleCcs2L() in ./economics-ccs2l (two purses:
// player distributable + house seed), NOT by settleParimutuel() below, which
// takes a single merged `distributable`. Callers that hold the round's
// (seed, stakes, rakeBps) should dispatch:
//
//   import { settleCcs2L, DEFAULT_CCS2L_PARAMS } from "./economics-ccs2l";
//   const econ = roundEconomics(seed, stakes, rakeBps);
//   const s = settleCcs2L(econ.distributable - econ.seed, econ.seed,
//                         crashBps, seats, reserveAtLock, DEFAULT_CCS2L_PARAMS);
//
// Invariants (proven in docs/marketplank/sim-settlement-ccs2l/ and
// DESIGN-PLANKCRASH-CCS2L-INTEGRATION-2026-08-31.md):
//   sum(playerPayout) == playerDistributable EXACTLY when any survivor exists
//   sum(houseBonus) + houseReturned == seed EXACTLY
//   house layer is PARTITION-INVARIANT (global reserve cap + linear caps only)
//   treasury receives ZERO player-pot cap residue (structural)
//   houseReturned -> protected reserve; ratified 40/40/20 applies to rake only.

export interface Seat {
  id: string;
  stake: bigint;
  targetBps: bigint;
}

export interface Allocation {
  id: string;
  survived: boolean;
  stake: bigint;
  targetBps: bigint;
  base: bigint;
  surplus: bigint;
  payout: bigint;
  net: bigint;
}

export interface Settlement {
  rule: AllocationRule;
  distributable: bigint;
  crashBps: bigint;
  survivorStake: bigint;
  totalWeight: bigint;
  basePool: bigint;
  surplusPool: bigint;
  totalPayout: bigint;
  /** Integer dust or intentionally undistributed surplus. */
  vaultRemainder: bigint;
  allBust: boolean;
  allocations: Allocation[];
}

function assertInputs(distributable: bigint, crashBps: bigint, seats: readonly Seat[]): void {
  if (distributable < 0n) throw new RangeError("negative distributable");
  if (crashBps < BPS) throw new RangeError("crash below 1.00x");
  const ids = new Set<string>();
  for (const seat of seats) {
    if (!seat.id) throw new RangeError("empty seat id");
    if (ids.has(seat.id)) throw new RangeError(`duplicate seat id: ${seat.id}`);
    ids.add(seat.id);
    if (seat.stake <= 0n) throw new RangeError(`non-positive stake: ${seat.id}`);
    if (seat.targetBps < MIN_TARGET_BPS) throw new RangeError(`target below minimum: ${seat.id}`);
  }
}

function proRata(pool: bigint, numerators: readonly bigint[], denominator: bigint): bigint[] {
  if (pool === 0n || denominator === 0n) return numerators.map(() => 0n);
  return numerators.map((numerator) => (pool * numerator) / denominator);
}

export function settleParimutuel(
  rule: AllocationRule,
  distributable: bigint,
  crashBps: bigint,
  seats: readonly Seat[],
): Settlement {
  if (rule === "ccs-2l") {
    throw new RangeError(
      "ccs-2l is two-purse: use settleCcs2L(playerDistributable, seedH, ...) from ./economics-ccs2l",
    );
  }
  assertInputs(distributable, crashBps, seats);

  const survived = seats.map((seat) => seat.targetBps <= crashBps);
  const survivorStake = seats.reduce((sum, seat, index) => sum + (survived[index] ? seat.stake : 0n), 0n);
  const allBust = survivorStake === 0n;

  let basePool = 0n;
  let surplusPool = 0n;
  let totalWeight = 0n;
  let bases = seats.map(() => 0n);
  let surpluses = seats.map(() => 0n);

  if (!allBust) {
    if (rule === "pfss") {
      basePool = distributable < survivorStake ? distributable : survivorStake;
      surplusPool = distributable - basePool;
      bases = proRata(
        basePool,
        seats.map((seat, index) => (survived[index] ? seat.stake : 0n)),
        survivorStake,
      );
      const riskWeights = seats.map((seat, index) =>
        survived[index] ? seat.stake * (seat.targetBps - BPS) : 0n,
      );
      totalWeight = riskWeights.reduce((sum, weight) => sum + weight, 0n);
      // If W == 0, surplus is deliberately not awarded to risk-free seats.
      // It remains a Vault remainder. MIN_TARGET_BPS normally prevents this,
      // but keeping the branch explicit makes the accounting total.
      surpluses = proRata(surplusPool, riskWeights, totalWeight);
    } else {
      const weights = seats.map((seat, index) => {
        if (!survived[index]) return 0n;
        return rule === "stake-only" ? seat.stake : seat.stake * seat.targetBps;
      });
      totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
      surplusPool = distributable;
      surpluses = proRata(distributable, weights, totalWeight);
    }
  }

  const allocations = seats.map<Allocation>((seat, index) => {
    const payout = bases[index] + surpluses[index];
    return {
      id: seat.id,
      survived: survived[index],
      stake: seat.stake,
      targetBps: seat.targetBps,
      base: bases[index],
      surplus: surpluses[index],
      payout,
      net: payout - seat.stake,
    };
  });
  const totalPayout = allocations.reduce((sum, allocation) => sum + allocation.payout, 0n);
  const vaultRemainder = distributable - totalPayout;
  if (totalPayout > distributable || vaultRemainder < 0n) throw new Error("conservation failure");

  return {
    rule,
    distributable,
    crashBps,
    survivorStake,
    totalWeight,
    basePool,
    surplusPool,
    totalPayout,
    vaultRemainder,
    allBust,
    allocations,
  };
}

export function roundEconomics(seed: bigint, stakes: readonly bigint[], rakeBps: bigint) {
  if (seed < 0n || stakes.some((stake) => stake < 0n)) throw new RangeError("negative round funding");
  if (rakeBps < 0n || rakeBps > BPS) throw new RangeError("invalid rake");
  const playerPool = stakes.reduce((sum, stake) => sum + stake, 0n);
  const gross = seed + playerPool;
  const playerDistributable = (playerPool * (BPS - rakeBps)) / BPS;
  const distributable = seed + playerDistributable;
  return { seed, playerPool, gross, rake: playerPool - playerDistributable, distributable };
}

/**
 * Ratified one-pass 25% burn / 69% community / 6% founder split of net
 * player rake. Revised 2026-09-05 (SPEC-monotonic-vault-positive-sum) from
 * the earlier 40/40/20: shifting weight from burn and founders into the
 * community share is the entire growth engine behind PlankCrash's
 * participation-count vault bonus and PlankLottery's growing carve ceiling,
 * both fed exclusively by this community leg via PlankRakeRouter. Exact
 * mirror of contracts/PlankRakeRouter.sol's BURN_BPS/COMMUNITY_BPS.
 */
export function ratifiedRakeSplit(grossRake: bigint, keeperRewardBps = 0n) {
  if (grossRake < 0n) throw new RangeError("negative rake");
  if (keeperRewardBps < 0n || keeperRewardBps > BPS) throw new RangeError("invalid keeper reward");
  const keeper = (grossRake * keeperRewardBps) / BPS;
  const netRake = grossRake - keeper;
  const burn = (netRake * 2_500n) / BPS;
  const community = (netRake * 6_900n) / BPS;
  const founders = netRake - burn - community;
  return { grossRake, keeper, netRake, burn, community, founders };
}

export function sealLotteryEpoch(
  rollover: bigint,
  freshCommunityFunding: bigint,
  externalFunding: bigint,
  founderFeeBps: bigint,
) {
  if ([rollover, freshCommunityFunding, externalFunding].some((value) => value < 0n)) {
    throw new RangeError("negative lottery funding");
  }
  if (founderFeeBps < 0n || founderFeeBps >= BPS) throw new RangeError("invalid lottery fee");
  const gross = rollover + freshCommunityFunding + externalFunding;
  const founderFee = (gross * founderFeeBps) / BPS;
  return { gross, founderFee, netPrize: gross - founderFee };
}

/** Exact minimum gross capital whose floor-fee net is at least targetNet. */
export function minimumLotteryGross(targetNet: bigint, founderFeeBps: bigint): bigint {
  if (targetNet < 0n) throw new RangeError("negative target");
  if (founderFeeBps < 0n || founderFeeBps >= BPS) throw new RangeError("invalid lottery fee");
  let low = targetNet;
  let high = (targetNet * BPS + (BPS - founderFeeBps) - 1n) / (BPS - founderFeeBps) + 1n;
  while (low < high) {
    const mid = (low + high) / 2n;
    const net = mid - (mid * founderFeeBps) / BPS;
    if (net >= targetNet) high = mid;
    else low = mid + 1n;
  }
  return low;
}

export function minimumFreshForLotteryGrowth(
  priorNetPrize: bigint,
  consolation: bigint,
  minimumIncrease: bigint,
  externalFunding: bigint,
  founderFeeBps: bigint,
): bigint {
  if (consolation < 0n || consolation > priorNetPrize) throw new RangeError("invalid consolation");
  if (minimumIncrease <= 0n || externalFunding < 0n) throw new RangeError("invalid growth funding");
  const rollover = priorNetPrize - consolation;
  const requiredGross = minimumLotteryGross(priorNetPrize + minimumIncrease, founderFeeBps);
  const alreadyFunded = rollover + externalFunding;
  return requiredGross > alreadyFunded ? requiredGross - alreadyFunded : 0n;
}

export function targetToTick(targetBps: bigint, minTargetBps: bigint, tickSizeBps: bigint): bigint {
  if (tickSizeBps <= 0n) throw new RangeError("non-positive tick size");
  if (targetBps < minTargetBps) throw new RangeError("target below grid");
  if ((targetBps - minTargetBps) % tickSizeBps !== 0n) throw new RangeError("target is off grid");
  return (targetBps - minTargetBps) / tickSizeBps;
}

/** Highest grid tick whose raw target is <= crashBps, or -1 if none survives. */
export function crashToWinningTick(crashBps: bigint, minTargetBps: bigint, tickSizeBps: bigint): bigint {
  if (tickSizeBps <= 0n) throw new RangeError("non-positive tick size");
  if (crashBps < minTargetBps) return -1n;
  return (crashBps - minTargetBps) / tickSizeBps;
}

export function tickCount(minTargetBps: bigint, maxTargetBps: bigint, tickSizeBps: bigint): bigint {
  if (maxTargetBps < minTargetBps) throw new RangeError("reversed target range");
  if (tickSizeBps <= 0n) throw new RangeError("non-positive tick size");
  if ((maxTargetBps - minTargetBps) % tickSizeBps !== 0n) throw new RangeError("range is off grid");
  return (maxTargetBps - minTargetBps) / tickSizeBps + 1n;
}
