import { AbiCoder, keccak256, toUtf8Bytes } from "ethers";
import { BPS, type Seat } from "./economics";
import { DEFAULT_CCS2L_PARAMS, type Ccs2LParams, type Ccs2LSettlement } from "./economics-ccs2l";

export const CAPPED_POOL_RULE_ID = keccak256(toUtf8Bytes("capped-survivor-pool"));
export const CAPPED_POOL_RULE_VERSION = 1;
export type CappedPoolSettlement = Omit<Ccs2LSettlement, "rule"> & { rule: "capped-survivor-pool" };
export function cappedPoolParamsHash(p: Ccs2LParams = DEFAULT_CCS2L_PARAMS): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [CAPPED_POOL_RULE_ID, 1, p.floorBps, p.houseCapBps, p.houseRakeCapBps, p.maxVaultBonusBps, p.vaultBonusDecayWad],
  ));
}

/** Sorted-breakpoint reference, independent of Solidity's elimination loops.
 * Monetary values use integer arithmetic throughout. Dust returns to reserves.
 */
export function settleCappedPool(d: bigint, h: bigint, crash: bigint, seats: readonly Seat[],
  params: Ccs2LParams = DEFAULT_CCS2L_PARAMS): CappedPoolSettlement {
  if (seats.length > 256 || d < 0n || h < 0n || d > 10n ** 33n || h > 10n ** 33n
    || crash < BPS || crash > 100000000n || params.floorBps < 0n || params.floorBps > BPS) throw new RangeError("invalid capped pool inputs");
  const ids = new Set<string>(); let totalStake = 0n;
  const payouts = seats.map(s => {
    if (!s.id || ids.has(s.id) || s.stake <= 0n || s.stake > 10n ** 30n || s.targetBps < 10100n || s.targetBps > 100000000n) throw new RangeError("invalid capped seat");
    ids.add(s.id); totalStake += s.stake;
    return s.targetBps <= crash ? s.stake * params.floorBps / BPS : 0n;
  });
  if (totalStake > 10n ** 33n) throw new RangeError("stake bound");
  const active = seats.map((s, i) => ({ s, i, room: s.stake * s.targetBps / BPS - payouts[i] })).filter(x => x.s.targetBps <= crash);
  active.sort((a, b) => a.room * b.s.stake < b.room * a.s.stake ? -1 : a.room * b.s.stake > b.room * a.s.stake ? 1 : 0);
  const survivorStake = active.reduce((a, x) => a + x.s.stake, 0n);
  let weight = survivorStake, remaining = d + h - payouts.reduce((a, b) => a + b, 0n);
  if (remaining < 0n) throw new RangeError("survivor floor not funded");
  while (active.length && active[0].room * weight <= remaining * active[0].s.stake) {
    const x = active.shift()!; payouts[x.i] += x.room; remaining -= x.room; weight -= x.s.stake;
  }
  const lambda = weight ? remaining * 10n ** 18n / weight : 0n;
  for (const x of active) payouts[x.i] += remaining * x.s.stake / weight;
  let playerRemaining = d, totalBonus = 0n;
  const allocations = seats.map((s, i) => {
    const payout = payouts[i], playerPayout = payout < playerRemaining ? payout : playerRemaining;
    playerRemaining -= playerPayout;
    const houseBonus = payout - playerPayout; totalBonus += houseBonus;
    // Source attribution is not a separate entitlement. Report a floor only
    // up to the player-funded part so telemetry remains additive.
    const floor = s.targetBps <= crash ? s.stake * params.floorBps / BPS : 0n;
    const floorPayout = floor < playerPayout ? floor : playerPayout;
    return { ...s, survived: s.targetBps <= crash, playerPayout, houseBonus, payout,
      floorPayout, performancePayout: playerPayout - floorPayout, net: payout - s.stake };
  });
  return { rule: "capped-survivor-pool", playerDistributable: d, seedH: h, crashBps: crash,
    survivorStake, allBust: !survivorStake, totalPlayerPaid: d - playerRemaining, totalBonus,
    totalPayout: d - playerRemaining + totalBonus, houseReturned: h - totalBonus,
    bustedToReserve: playerRemaining, treasuryCapResidue: 0n, allocations,
    meta: { mode: survivorStake ? "normal" : "no-survivor", lambda, playerDust: 0n, dustIndex: -1 } };
}
