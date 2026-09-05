import {
  BPS,
  ratifiedRakeSplit,
  roundEconomics,
  settleParimutuel,
  type AllocationRule,
  type Seat,
} from "./economics";
import { DEFAULT_CCS2L_PARAMS, settleCcs2L, type Ccs2LSettlement } from "./economics-ccs2l";

/**
 * The laboratory economy kernel. Since 2026-09-05 the lottery half of this
 * file is a wei-faithful mirror of contracts/PlankLottery.sol (the ratified
 * progressive carve + the actuarial hit rule of
 * docs/marketplank/RESEARCH-game-theory-lottery-seed-resolution-2026-09-05.md):
 *
 *   - ROUND-ONLY ELIGIBILITY: every qualified settlement IS a draw among the
 *     seats of THAT round; there are no epochs, vouchers or tickets.
 *   - THE POOL IS A POOL: `pool` is net (fee-paid) money banked; the headline
 *     `committedPrize` is the pool as it stood when the previous round
 *     settled (prize snapshot, audit L-4). Funding during a round joins the
 *     next board.
 *   - ACTUARIAL HIT RULE: p = min(1/oddsOneIn, c/(kappa * W(P))) where c is the
 *     round's own contribution and W(P) the winner's take. Expected payout per
 *     round <= c/kappa < c, so the prize grows in expectation every round,
 *     forever, and a quiet round occupied by one principal is always
 *     negative-EV. There is NO forced hit (owner ruling 2026-09-05).
 *   - PROGRESSIVE CARVE: on a hit the winner receives W(P) = P(1 - x(P)) and
 *     the next board opens at S(P) = P x(P), x(P) = xMin + (xMax-xMin) P/(P+c),
 *     as ONE floor division (both W and S non-decreasing in P, W + S == P).
 *   - FOUNDER FEE on fresh inflow only; the carried seed is never re-taxed.
 */

export interface SimulationPolicy {
  rakeBps: bigint;
  /** Permanent qualified-volume rake staircase. */
  rakeFloorBps: bigint;
  rakeStepBps: bigint;
  rakeVolumeStep: bigint;
  keeperRewardBps: bigint;
  protectedPrincipalBps: bigint;
  /** Share of the already-ratified community rake routed to the lottery each qualified game. */
  powerboardFundingBps: bigint;
  crashSeed: bigint;
  emissionBufferCap: bigint;
  lotteryFounderFeeBps: bigint;
  /** Flat ceiling: a round never draws better than 1 in this. */
  lotteryOddsOneIn: bigint;
  /** Actuarial loading kappa in bps (> BPS): the pool keeps >= 1 - 1/kappa of every contribution in expectation. */
  lotteryKappaBps: bigint;
  /** Progressive carve x(P) = carveMinBps + (carveMaxBps - carveMinBps) * P / (P + carveHalfSaturation). */
  carveMinBps: bigint;
  carveMaxBps: bigint;
  carveHalfSaturation: bigint;
  allocationRule: AllocationRule;
  minimumPlayers: number;
  minimumStake: bigint;
}

export type SimulationPlayer = Seat;

/**
 * Host laboratory override for the draw: "none" = natural (the committed
 * uniform sample decides), "hit" / "miss" = host-forced laboratory outcome,
 * flagged as such in the replay log. Natural is the only production path.
 */
export type LotteryOutcome = "hit" | "miss" | "none";

/** Probability fixed point shared with PlankLottery (PROB_ONE == certainty). */
export const PROB_ONE = 10n ** 18n;

export interface IterationInput {
  players: readonly SimulationPlayer[];
  crashBps: bigint;
  lotteryOutcome: LotteryOutcome;
  /** Uniform sample in [0, PROB_ONE) derived from the committed reveal; null = no sample (counts as a miss). */
  lotteryDrawE18?: bigint | null;
  externalLotteryFunding?: bigint;
}

export interface SimulationTotals {
  freshWagers: bigint;
  grossRake: bigint;
  keeperRewards: bigint;
  burned: bigint;
  communityFunded: bigint;
  /** Cumulative community allocation actually routed into the lottery (gross, before the founder fee). */
  powerboardFunded: bigint;
  crashFounderRake: bigint;
  /** Cumulative GROSS inflow the lottery received (router leg + overflow + external). */
  lotteryGrossConstituted: bigint;
  lotteryFounderFees: bigint;
  playerCrashPayouts: bigint;
  lotteryWinnerPayouts: bigint;
  /** Cumulative carve that re-seeded the next board after hits. */
  lotterySeeded: bigint;
  vaultRemainders: bigint;
  externalLotteryFunding: bigint;
  /** Cumulative emission-buffer credits seeded into flights (the Vault side's
   * contribution to games). Additive; absent in pre-2026-09-03 snapshots. */
  flightSeeded: bigint;
}

export interface LotteryState {
  /** Net (fee-paid) money banked on the board right now. */
  pool: bigint;
  /** The prize the NEXT draw pays: `pool` as of the last qualified settlement. */
  committedPrize: bigint;
  draws: bigint;
  hits: bigint;
  highWaterPrize: bigint;
  /** The last draw's threshold (PROB_ONE scale) and contribution, for the record. */
  lastThresholdE18: bigint;
  lastContribution: bigint;
}

export interface SimulationState {
  iteration: bigint;
  protectedPrincipal: bigint;
  emissionBuffer: bigint;
  lottery: LotteryState;
  totals: SimulationTotals;
}

export type LotteryEvent = "none" | "funding" | "miss" | "hit";

export interface IterationResult {
  state: SimulationState;
  qualified: boolean;
  seed: bigint;
  /**
   * Parimutuel rules yield a Settlement; "ccs-2l" yields a Ccs2LSettlement.
   * Both expose allocations[{id, payout, net, survived, ...}] so downstream
   * seat accounting (lib/playtest-rooms.ts) is rule-agnostic.
   */
  settlement?: ReturnType<typeof settleParimutuel> | Ccs2LSettlement;
  lotteryEvent: LotteryEvent;
  /** The draw record: prize on the board, threshold, sample, natural result, forced flag, W and S. */
  lotteryDraw: {
    prize: bigint;
    contribution: bigint;
    thresholdE18: bigint;
    sampleE18: bigint | null;
    natural: boolean | null;
    forced: boolean;
    winnerPaid: bigint;
    seeded: bigint;
  } | null;
  effectiveRakeBps: bigint;
  evolutionTier: bigint;
}

export interface EvolutionQuote {
  effectiveRakeBps: bigint;
  tier: bigint;
  qualifiedVolume: bigint;
  nextMilestoneVolume: bigint | null;
  volumeRemaining: bigint;
}

export function evolutionQuote(policy: SimulationPolicy, qualifiedVolume: bigint): EvolutionQuote {
  if (qualifiedVolume < 0n) throw new RangeError("negative qualified volume");
  const possibleDrop = policy.rakeBps - policy.rakeFloorBps;
  const maxTiers = possibleDrop === 0n ? 0n : (possibleDrop + policy.rakeStepBps - 1n) / policy.rakeStepBps;
  const earnedTiers = qualifiedVolume / policy.rakeVolumeStep;
  const tier = earnedTiers < maxTiers ? earnedTiers : maxTiers;
  const rawDrop = tier * policy.rakeStepBps;
  const drop = rawDrop < possibleDrop ? rawDrop : possibleDrop;
  const effectiveRakeBps = policy.rakeBps - drop;
  const nextMilestoneVolume = tier < maxTiers ? (tier + 1n) * policy.rakeVolumeStep : null;
  return {
    effectiveRakeBps,
    tier,
    qualifiedVolume,
    nextMilestoneVolume,
    volumeRemaining: nextMilestoneVolume === null ? 0n : nextMilestoneVolume - qualifiedVolume,
  };
}

const ZERO_TOTALS: SimulationTotals = {
  freshWagers: 0n,
  grossRake: 0n,
  keeperRewards: 0n,
  burned: 0n,
  communityFunded: 0n,
  powerboardFunded: 0n,
  crashFounderRake: 0n,
  lotteryGrossConstituted: 0n,
  lotteryFounderFees: 0n,
  playerCrashPayouts: 0n,
  lotteryWinnerPayouts: 0n,
  lotterySeeded: 0n,
  vaultRemainders: 0n,
  externalLotteryFunding: 0n,
  flightSeeded: 0n,
};

export function validatePolicy(policy: SimulationPolicy): void {
  const bounded = [
    policy.rakeBps,
    policy.rakeFloorBps,
    policy.rakeStepBps,
    policy.keeperRewardBps,
    policy.protectedPrincipalBps,
    policy.powerboardFundingBps,
    policy.lotteryFounderFeeBps,
    policy.carveMinBps,
    policy.carveMaxBps,
  ];
  if (bounded.some((value) => value < 0n || value > BPS)) throw new RangeError("invalid bps policy");
  if (policy.lotteryFounderFeeBps === BPS) throw new RangeError("lottery fee consumes prize");
  if (policy.rakeFloorBps > policy.rakeBps || policy.rakeStepBps <= 0n || policy.rakeVolumeStep <= 0n) {
    throw new RangeError("invalid evolutionary rake policy");
  }
  if (policy.minimumPlayers < 1 || !Number.isSafeInteger(policy.minimumPlayers)) {
    throw new RangeError("invalid minimum players");
  }
  const amounts = [policy.crashSeed, policy.emissionBufferCap];
  if (amounts.some((value) => value < 0n) || policy.minimumStake <= 0n) {
    throw new RangeError("invalid amount policy");
  }
  // Same admissibility as PlankLottery's constructor.
  if (policy.lotteryOddsOneIn < 2n) throw new RangeError("the ball must be a genuine draw (oddsOneIn >= 2)");
  if (policy.lotteryKappaBps <= BPS) throw new RangeError("kappa must exceed 1 (strict prize growth)");
  if (policy.carveMaxBps >= BPS || policy.carveMinBps === 0n || policy.carveMinBps >= policy.carveMaxBps) {
    throw new RangeError("carve must be progressive: 0 < xMin < xMax < 1");
  }
  if (policy.carveHalfSaturation <= 0n) throw new RangeError("carve half-saturation must be positive");
}

export function initialSimulationState(policy: SimulationPolicy): SimulationState {
  validatePolicy(policy);
  return {
    iteration: 0n,
    protectedPrincipal: 0n,
    emissionBuffer: 0n,
    lottery: {
      pool: 0n,
      committedPrize: 0n,
      draws: 0n,
      hits: 0n,
      highWaterPrize: 0n,
      lastThresholdE18: 0n,
      lastContribution: 0n,
    },
    totals: { ...ZERO_TOTALS },
  };
}

/** Mirror of PlankLottery.carve(): ONE floor division, W + S == P exactly. */
export function carvePrize(prize: bigint, policy: SimulationPolicy): { winnerPaid: bigint; seeded: bigint } {
  if (prize <= 0n) return { winnerPaid: 0n, seeded: 0n };
  const denom = prize + policy.carveHalfSaturation;
  const numer = policy.carveMinBps * denom + (policy.carveMaxBps - policy.carveMinBps) * prize;
  const seeded = (prize * numer) / (BPS * denom);
  return { winnerPaid: prize - seeded, seeded };
}

/** Effective carve rate at `prize`, bps (informational). */
export function carveBps(prize: bigint, policy: SimulationPolicy): bigint {
  if (prize <= 0n) return policy.carveMinBps;
  return policy.carveMinBps + ((policy.carveMaxBps - policy.carveMinBps) * prize) / (prize + policy.carveHalfSaturation);
}

/**
 * Mirror of PlankLottery.hitThreshold(): the round's hit probability on the
 * PROB_ONE scale for a round that contributed `contribution` (gross, before
 * the founder fee -- what the contract calls c) against `prize`:
 *   min( PROB_ONE / oddsOneIn , c * PROB_ONE / (kappa * W(prize)) ).
 */
export function hitThresholdE18(contribution: bigint, prize: bigint, policy: SimulationPolicy): bigint {
  if (contribution < 0n || prize < 0n) throw new RangeError("negative lottery inputs");
  const flat = PROB_ONE / policy.lotteryOddsOneIn;
  const { winnerPaid } = carvePrize(prize, policy);
  if (winnerPaid === 0n) return flat;
  const actuarial = (contribution * PROB_ONE * BPS) / (policy.lotteryKappaBps * winnerPaid);
  return actuarial < flat ? actuarial : flat;
}

/** Fee-on-inflow funding of the pool (mirror of PlankLottery.fund()). */
function fundLottery(state: SimulationState, policy: SimulationPolicy, gross: bigint): void {
  if (gross <= 0n) return;
  const fee = (gross * policy.lotteryFounderFeeBps) / BPS;
  state.lottery.pool += gross - fee;
  state.totals.lotteryGrossConstituted += gross;
  state.totals.lotteryFounderFees += fee;
}

function cloneState(state: SimulationState): SimulationState {
  return { ...state, lottery: { ...state.lottery }, totals: { ...state.totals } };
}

export function simulateIteration(
  prior: SimulationState,
  policy: SimulationPolicy,
  input: IterationInput,
): IterationResult {
  validatePolicy(policy);
  const state = cloneState(prior);
  state.iteration += 1n;
  const external = input.externalLotteryFunding ?? 0n;
  if (external < 0n) throw new RangeError("negative external funding");
  state.totals.externalLotteryFunding += external;
  fundLottery(state, policy, external);
  const sample = input.lotteryDrawE18 ?? null;
  if (sample !== null && (sample < 0n || sample >= PROB_ONE)) throw new RangeError("lottery sample out of range");

  const qualified = input.players.length >= policy.minimumPlayers
    && input.players.every((player) => player.stake >= policy.minimumStake);
  let settlement: IterationResult["settlement"];
  let seed = 0n;
  let lotteryEvent: LotteryEvent = "none";
  let lotteryDraw: IterationResult["lotteryDraw"] = null;
  const evolution = evolutionQuote(policy, prior.totals.freshWagers);
  if (qualified) {
    seed = state.emissionBuffer < policy.crashSeed ? state.emissionBuffer : policy.crashSeed;
    state.emissionBuffer -= seed;
    state.totals.flightSeeded = (state.totals.flightSeeded ?? 0n) + seed;
    const stakes = input.players.map((player) => player.stake);
    const economics = roundEconomics(seed, stakes, evolution.effectiveRakeBps);
    const split = ratifiedRakeSplit(economics.rake, policy.keeperRewardBps);
    // Undistributed value returning to the Vault this iteration. For the
    // parimutuel rules this is the classic vaultRemainder; for ccs-2l it is
    // houseReturned (+ bustedToReserve on all-bust rounds) -- the protected-
    // reserve routing, which here flows back into the emission buffer (the
    // seed's source) and is NEVER split through the community/principal path.
    let vaultRemainder = 0n;
    let reserveReturn = 0n;
    if (policy.allocationRule === "ccs-2l") {
      // reserveAtLock = the emission buffer snapshot after the seed draw:
      // the funds actually still protecting the house when locks are accepted.
      // The round's NET rake (after the keeper bounty) is the base of the v2
      // actuarial house cap, exactly as PlankCrash passes it.
      const ccs = settleCcs2L(
        economics.distributable - seed,
        seed,
        input.crashBps,
        input.players,
        state.emissionBuffer,
        DEFAULT_CCS2L_PARAMS,
        split.netRake,
      );
      settlement = ccs;
      reserveReturn = ccs.houseReturned + ccs.bustedToReserve;
      state.totals.playerCrashPayouts += ccs.totalPayout;
      state.emissionBuffer += reserveReturn;
      state.totals.vaultRemainders += reserveReturn;
    } else {
      const parimutuel = settleParimutuel(
        policy.allocationRule,
        economics.distributable,
        input.crashBps,
        input.players,
      );
      settlement = parimutuel;
      vaultRemainder = parimutuel.vaultRemainder;
      state.totals.playerCrashPayouts += parimutuel.totalPayout;
      state.totals.vaultRemainders += vaultRemainder;
    }

    state.totals.freshWagers += economics.playerPool;
    state.totals.grossRake += split.grossRake;
    state.totals.keeperRewards += split.keeper;
    state.totals.burned += split.burn;
    state.totals.communityFunded += split.community;
    state.totals.crashFounderRake += split.founders;

    // The lottery leg is a subdivision of the existing community allocation,
    // not a new rake or an unbacked liability. `contribution` is the round's
    // c: gross routed to the lottery, the base of the actuarial hit rule.
    const contribution = (split.community * policy.powerboardFundingBps) / BPS;
    state.totals.powerboardFunded += contribution;
    fundLottery(state, policy, contribution);
    const communityReturn = (split.community - contribution) + vaultRemainder;
    const principal = (communityReturn * policy.protectedPrincipalBps) / BPS;
    state.protectedPrincipal += principal;
    state.emissionBuffer += communityReturn - principal;
    if (state.emissionBuffer > policy.emissionBufferCap) {
      // Overflow cascades to the lottery through fund(): fee on inflow.
      fundLottery(state, policy, state.emissionBuffer - policy.emissionBufferCap);
      state.emissionBuffer = policy.emissionBufferCap;
    }

    // THE DRAW (mirror of PlankLottery.recordRound): pays only the prize
    // banked BEFORE this round; priced by this round's own contribution.
    const prize = prior.lottery.committedPrize;
    if (prize > 0n) {
      state.lottery.draws += 1n;
      const thresholdE18 = hitThresholdE18(contribution, prize, policy);
      const natural = sample === null ? false : sample < thresholdE18;
      const forced = input.lotteryOutcome !== "none" && (input.lotteryOutcome === "hit") !== natural;
      const hit = input.lotteryOutcome === "none" ? natural : input.lotteryOutcome === "hit";
      let winnerPaid = 0n;
      let seeded = 0n;
      if (hit) {
        ({ winnerPaid, seeded } = carvePrize(prize, policy));
        // W + S == P exactly; the post-snapshot inflow (pool - prize) stays.
        state.lottery.pool = state.lottery.pool - prize + seeded;
        state.lottery.hits += 1n;
        state.totals.lotteryWinnerPayouts += winnerPaid;
        state.totals.lotterySeeded += seeded;
      }
      state.lottery.lastThresholdE18 = thresholdE18;
      state.lottery.lastContribution = contribution;
      lotteryEvent = hit ? "hit" : "miss";
      lotteryDraw = { prize, contribution, thresholdE18, sampleE18: sample, natural: sample === null ? null : natural, forced, winnerPaid, seeded };
    } else {
      lotteryEvent = "funding";
    }
    state.lottery.committedPrize = state.lottery.pool;
    if (state.lottery.pool > state.lottery.highWaterPrize) state.lottery.highWaterPrize = state.lottery.pool;
  }

  assertSimulationInvariants(prior, state, policy, qualified);
  return {
    state,
    qualified,
    seed,
    settlement,
    lotteryEvent,
    lotteryDraw,
    effectiveRakeBps: evolution.effectiveRakeBps,
    evolutionTier: evolution.tier,
  };
}

export function accountedAssets(state: SimulationState): bigint {
  return state.protectedPrincipal + state.emissionBuffer + state.lottery.pool;
}

export function assertSimulationInvariants(
  prior: SimulationState,
  state: SimulationState,
  policy: SimulationPolicy,
  qualified: boolean,
): void {
  void policy;
  if (state.protectedPrincipal < prior.protectedPrincipal) throw new Error("principal decreased");
  if (state.lottery.highWaterPrize < prior.lottery.highWaterPrize) throw new Error("high water decreased");
  if (state.lottery.hits < prior.lottery.hits || state.lottery.draws < prior.lottery.draws) throw new Error("draw counters decreased");
  if (qualified && state.totals.freshWagers <= prior.totals.freshWagers) {
    throw new Error("qualified iteration did not add wagers");
  }
  // The committed prize is always payable from the pool (PlankLottery L-1).
  if (state.lottery.committedPrize > state.lottery.pool) throw new Error("committed prize exceeds the pool");
  for (const value of [
    state.protectedPrincipal,
    state.emissionBuffer,
    state.lottery.pool,
    state.lottery.committedPrize,
    accountedAssets(state),
  ]) {
    if (value < 0n) throw new Error("negative liability");
  }
}

/** JSON-safe canonical representation for APIs, snapshots, and replay fixtures. */
export function serializeSimulationState(state: SimulationState): unknown {
  return JSON.parse(JSON.stringify(state, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

/** Small deterministic generator; never use it as production randomness. */
export function seededSimulationRandom(seed: bigint): () => bigint {
  let state = BigInt.asUintN(64, seed);
  return () => {
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    state = BigInt.asUintN(64, state);
    return state;
  };
}
