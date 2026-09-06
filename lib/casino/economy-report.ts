import { BPS } from "./economics";
import { carveBps, carvePrize, hitThresholdE18, PROB_ONE, type SimulationPolicy, type SimulationState } from "./simulation";

/**
 * Player-facing economy derivations shared by the room snapshot (server), the
 * arcade panel (client, via the snapshot) and the unit tests. Every figure is
 * derived from the SAME kernel functions the engine settles with (carvePrize,
 * hitThresholdE18); nothing here is a second opinion.
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

export interface LotteryPrizeQuote {
  status: "active" | "funding";
  /** Net money banked on the board right now (includes funding since the last settlement). */
  pool: bigint;
  /** The prize the NEXT draw pays (the pool as of the last qualified settlement). */
  prize: bigint;
  /** Displayed == redeemable: the winner receives exactly this on a hit ... */
  winnerTake: bigint;
  /** ... and the next board opens with exactly this. */
  nextSeed: bigint;
  carveBps: bigint;
  /** The contribution the threshold below is quoted at (a typical round's routed lottery leg). */
  quotedContribution: bigint;
  /** Hit threshold on the PROB_ONE scale at that contribution. */
  thresholdE18: bigint;
  /** ceil(PROB_ONE / threshold): "1 in N" for a round of that size; null when the threshold is 0. */
  oddsOneIn: bigint | null;
  /** The flat ceiling the rule never beats. */
  flatOddsOneIn: bigint;
  /** Which branch of min() binds: "flat" (small prize) or "actuarial" (prize priced by contribution). */
  regime: "flat" | "actuarial";
  kappaBps: bigint;
  /** Expected net growth of the pool per round of that size: c(1 - fee) - E[payout]. */
  expectedGrowthPerRound: bigint;
  highWaterPrize: bigint;
  draws: bigint;
  hits: bigint;
}

/**
 * The prize as players should read it under the actuarial rule: what the
 * next draw pays, what the winner takes, what re-seeds the board, and the
 * odds a round of a given size has. `quotedContribution` should be the
 * average routed lottery leg of recent rounds (see contributionPace) so the
 * odds shown are the odds THIS table actually plays at.
 */
export function lotteryPrizeQuote(state: SimulationState, policy: SimulationPolicy, quotedContribution: bigint): LotteryPrizeQuote {
  if (quotedContribution < 0n) throw new RangeError("negative contribution");
  const lottery = state.lottery;
  const prize = lottery.committedPrize;
  const { winnerPaid, seeded } = carvePrize(prize, policy);
  const thresholdE18 = prize > 0n ? hitThresholdE18(quotedContribution, prize, policy) : 0n;
  const flat = PROB_ONE / policy.lotteryOddsOneIn;
  const oddsOneIn = thresholdE18 > 0n ? (PROB_ONE + thresholdE18 - 1n) / thresholdE18 : null;
  const expectedPayout = (thresholdE18 * winnerPaid) / PROB_ONE;
  const netInflow = quotedContribution - (quotedContribution * policy.lotteryFounderFeeBps) / BPS;
  return {
    status: prize > 0n ? "active" : "funding",
    pool: lottery.pool,
    prize,
    winnerTake: winnerPaid,
    nextSeed: seeded,
    carveBps: carveBps(prize, policy),
    quotedContribution,
    thresholdE18,
    oddsOneIn,
    flatOddsOneIn: policy.lotteryOddsOneIn,
    regime: prize > 0n && thresholdE18 < flat ? "actuarial" : "flat",
    kappaBps: policy.lotteryKappaBps,
    expectedGrowthPerRound: netInflow - expectedPayout,
    highWaterPrize: lottery.highWaterPrize,
    draws: lottery.draws,
    hits: lottery.hits,
  };
}

/** A player's own chance this round: the round's hit chance times their
 * stake share of the round (round-only eligibility, stake-weighted ticket).
 * All exact integers; "1 in N" is a ceiling. */
export function playerRoundOdds(thresholdE18: bigint, myStake: bigint, roundStake: bigint, winnerTake: bigint) {
  if (myStake < 0n || roundStake < 0n || myStake > roundStake || thresholdE18 < 0n) throw new RangeError("invalid round odds inputs");
  const sharePpm = roundStake > 0n ? (myStake * 1_000_000n) / roundStake : 0n;
  const mineE18 = roundStake > 0n ? (thresholdE18 * myStake) / roundStake : 0n;
  return {
    sharePpm,
    oddsOneIn: mineE18 > 0n ? (PROB_ONE + mineE18 - 1n) / mineE18 : null,
    probabilityWeightedPrize: (mineE18 * winnerTake) / PROB_ONE,
  };
}

/** Share of each round's pot that reaches the protected Vault, in parts per
 * million: rake × community leg (69% of net rake, revised 2026-09-05 from
 * 40% -- SPEC-monotonic-vault-positive-sum §4) × retained community share
 * (1 − powerboardFundingBps) × protectedPrincipalBps. With the default
 * playtest policy: 4.5% × 69% × 35% × 50% = 0.5434% ≈ 5,434 ppm. */
export function vaultShareOfPotPpm(policy: SimulationPolicy, effectiveRakeBps: bigint): bigint {
  const netRakeBps = effectiveRakeBps * (BPS - policy.keeperRewardBps) / BPS;
  const communityBps = 6_900n;
  const retainedBps = BPS - policy.powerboardFundingBps;
  return (netRakeBps * communityBps * retainedBps * policy.protectedPrincipalBps * 1_000_000n) / (BPS * BPS * BPS * BPS);
}

/** Lottery funding share of each round's pot, ppm (default: 4.5% × 69% × 65% ≈ 2.02%). */
export function lotteryShareOfPotPpm(policy: SimulationPolicy, effectiveRakeBps: bigint): bigint {
  const netRakeBps = effectiveRakeBps * (BPS - policy.keeperRewardBps) / BPS;
  return (netRakeBps * 6_900n * policy.powerboardFundingBps * 1_000_000n) / (BPS * BPS * BPS);
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

export interface ContributionPace {
  /** Average routed lottery leg over the newest 10 settled rounds. */
  averageContributionPerRound: bigint;
  roundsSampled: number;
  /** Expected rounds to the next hit at that pace: ceil(PROB_ONE / threshold); null with no sample or a zero threshold. */
  expectedRoundsToHit: bigint | null;
  expectedSecondsToHit: bigint | null;
}

export function contributionPace(recentContributions: readonly bigint[], thresholdE18: bigint, cadenceSeconds: bigint): ContributionPace {
  const sampled = recentContributions.slice(0, 10);
  const total = sampled.reduce((sum, value) => sum + value, 0n);
  const average = sampled.length ? total / BigInt(sampled.length) : 0n;
  if (!sampled.length || thresholdE18 <= 0n) {
    return { averageContributionPerRound: average, roundsSampled: sampled.length, expectedRoundsToHit: null, expectedSecondsToHit: null };
  }
  const rounds = (PROB_ONE + thresholdE18 - 1n) / thresholdE18;
  return { averageContributionPerRound: average, roundsSampled: sampled.length, expectedRoundsToHit: rounds, expectedSecondsToHit: rounds * cadenceSeconds };
}
