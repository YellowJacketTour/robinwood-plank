import { BPS, minimumLotteryGross } from "./economics";
import { nextCycleBase, type SimulationPolicy, type SimulationState } from "./simulation";

/**
 * Player-facing economy derivations shared by the room snapshot (server), the
 * arcade panel (client, via the snapshot) and the unit tests. Every figure is
 * derived from the SAME kernel functions the engine settles with
 * (minimumLotteryGross, nextCycleBase); nothing here is a second opinion.
 *
 * Laboratory denomination: 1 test credit = 1e-6 ETH (1,000,000 credits =
 * 1 ETH). USD is a display-only quote supplied by the client; it never
 * enters this module.
 */

export const CREDITS_PER_ETH = 1_000_000n;

/** Exact ETH string for a credit amount (no floating point). Trailing zeros
 * are trimmed to a minimum of `minFraction` decimals. */
export function creditsToEth(credits: bigint, minFraction = 3): string {
  if (credits < 0n) return `-${creditsToEth(-credits, minFraction)}`;
  const whole = credits / CREDITS_PER_ETH;
  let fraction = (credits % CREDITS_PER_ETH).toString().padStart(6, "0");
  while (fraction.length > minFraction && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return fraction.length ? `${whole}.${fraction}` : whole.toString();
}

/** USD value of a credit amount at a USD/ETH quote, or null without a quote. */
export function creditsToUsd(credits: bigint, ethUsd: number | null | undefined): number | null {
  if (!(typeof ethUsd === "number" && ethUsd > 0 && Number.isFinite(ethUsd))) return null;
  return Number(credits) / Number(CREDITS_PER_ETH) * ethUsd;
}

export interface LotteryActivationQuote {
  awaitingSeal: boolean;
  readyForDraw: boolean;
  status: "active" | "funding";
  /** Net prize paid on a hit once active: the sealed prize, or the next target. */
  target: bigint;
  /** Gross (fee-inclusive) funding the target needs — the engine's seal gate. */
  requiredGross: bigint;
  /** Base the cycle ratchets to after a paid hit. */
  nextBase: bigint;
  /** Gross the reset reserve must hold before readyForDraw arms. */
  requiredReserve: bigint;
  /** rollover + pendingFunding (gross toward the next seal). */
  fundedGross: bigint;
  resetReserve: bigint;
  /** What the prize is worth right now: netPrize when sealed, else funded gross. */
  prizeNow: bigint;
  prizeShort: bigint;
  reserveShort: bigint;
  /** Credits still needed before a draw can happen (0 ⇔ readyForDraw after settlement). */
  remaining: bigint;
  requiredTotal: bigint;
  fundedTotal: bigint;
  fundedBps: bigint;
}

/** Remaining-to-activation, mirroring sealFromFunding + fundResetReserve:
 * the prize bucket seals when rollover + pending ≥ requiredGross; the surplus
 * pending then flows into the reset reserve, which must reach
 * minimumLotteryGross(nextCycleBase) before a draw is exposed. Reserve
 * surplus never flows back to the prize, so the two shortfalls are summed
 * per bucket instead of netted. */
export function lotteryActivationQuote(state: SimulationState, policy: SimulationPolicy): LotteryActivationQuote {
  const lottery = state.lottery;
  const target = lottery.awaitingSeal ? lottery.nextPrizeTarget : lottery.netPrize;
  const requiredGross = lottery.awaitingSeal ? minimumLotteryGross(target, policy.lotteryFounderFeeBps) : 0n;
  const nextBase = nextCycleBase(lottery.cycleBase, policy);
  const requiredReserve = minimumLotteryGross(nextBase, policy.lotteryFounderFeeBps);
  const fundedGross = lottery.rollover + lottery.pendingFunding;
  const prizeShort = requiredGross > fundedGross ? requiredGross - fundedGross : 0n;
  const surplus = fundedGross > requiredGross ? fundedGross - requiredGross : 0n;
  const reserveCovered = lottery.resetReserve + surplus;
  const reserveShort = requiredReserve > reserveCovered ? requiredReserve - reserveCovered : 0n;
  const remaining = prizeShort + reserveShort;
  const requiredTotal = requiredGross + requiredReserve;
  const fundedTotal = requiredTotal - remaining;
  return {
    awaitingSeal: lottery.awaitingSeal,
    readyForDraw: lottery.readyForDraw,
    status: lottery.readyForDraw ? "active" : "funding",
    target,
    requiredGross,
    nextBase,
    requiredReserve,
    fundedGross,
    resetReserve: lottery.resetReserve,
    prizeNow: lottery.awaitingSeal ? fundedGross : lottery.netPrize,
    prizeShort,
    reserveShort,
    remaining,
    requiredTotal,
    fundedTotal,
    fundedBps: requiredTotal > 0n ? (fundedTotal * BPS) / requiredTotal : BPS,
  };
}

/** Share of each round's pot that reaches the protected Vault, in parts per
 * million: rake × community leg (40% of net rake) × retained community
 * share (1 − powerboardFundingBps) × protectedPrincipalBps. With the
 * default playtest policy: 4.5% × 40% × 35% × 50% = 0.315% = 3,150 ppm. */
export function vaultShareOfPotPpm(policy: SimulationPolicy, effectiveRakeBps: bigint): bigint {
  const netRakeBps = effectiveRakeBps * (BPS - policy.keeperRewardBps) / BPS;
  const communityBps = 4_000n;
  const retainedBps = BPS - policy.powerboardFundingBps;
  return (netRakeBps * communityBps * retainedBps * policy.protectedPrincipalBps * 1_000_000n) / (BPS * BPS * BPS * BPS);
}

/** Powerboard funding share of each round's pot, ppm (default: 4.5% × 40% × 65% = 1.17%). */
export function lotteryShareOfPotPpm(policy: SimulationPolicy, effectiveRakeBps: bigint): bigint {
  const netRakeBps = effectiveRakeBps * (BPS - policy.keeperRewardBps) / BPS;
  return (netRakeBps * 4_000n * policy.powerboardFundingBps * 1_000_000n) / (BPS * BPS * BPS);
}

/** Growth of the Vault this round in bps of the previous balance; null on
 * the genesis round (previous balance 0) where a ratio is meaningless. */
export function vaultGrowthBps(previous: bigint, added: bigint): bigint | null {
  if (previous <= 0n) return null;
  return (added * BPS) / previous;
}

/** Share (bps) of the vault-side reserves (principal + emission buffer
 * before the draw) that this round's seed represents. */
export function seedShareBps(seed: bigint, reservesBeforeSeed: bigint): bigint {
  if (reservesBeforeSeed <= 0n) return 0n;
  return (seed * BPS) / reservesBeforeSeed;
}

export interface ActivationPace {
  averageFundingPerRound: bigint;
  roundsSampled: number;
  /** Ceil(remaining ÷ average); null when nothing has been funded yet. */
  roundsToActivation: bigint | null;
  secondsToActivation: bigint | null;
}

export function activationPace(remaining: bigint, recentFunding: readonly bigint[], cadenceSeconds: bigint): ActivationPace {
  const sampled = recentFunding.slice(0, 10);
  const total = sampled.reduce((sum, value) => sum + value, 0n);
  const average = sampled.length ? total / BigInt(sampled.length) : 0n;
  if (remaining <= 0n) return { averageFundingPerRound: average, roundsSampled: sampled.length, roundsToActivation: 0n, secondsToActivation: 0n };
  if (average <= 0n) return { averageFundingPerRound: average, roundsSampled: sampled.length, roundsToActivation: null, secondsToActivation: null };
  const rounds = (remaining + average - 1n) / average;
  return { averageFundingPerRound: average, roundsSampled: sampled.length, roundsToActivation: rounds, secondsToActivation: rounds * cadenceSeconds };
}
