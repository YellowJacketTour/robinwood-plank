import {
  BPS,
  minimumLotteryGross,
  ratifiedRakeSplit,
  roundEconomics,
  sealLotteryEpoch,
  settleParimutuel,
  type AllocationRule,
  type Seat,
} from "./economics";

export interface SimulationPolicy {
  rakeBps: bigint;
  keeperRewardBps: bigint;
  protectedPrincipalBps: bigint;
  crashSeed: bigint;
  emissionBufferCap: bigint;
  lotteryFounderFeeBps: bigint;
  lotteryInitialBase: bigint;
  lotteryMinimumIncrease: bigint;
  lotteryBaseGrowthBps: bigint;
  lotteryMinimumBaseStep: bigint;
  consolation: bigint;
  allocationRule: AllocationRule;
  minimumPlayers: number;
  minimumStake: bigint;
}

export type SimulationPlayer = Seat;

export type LotteryOutcome = "hit" | "miss" | "none";

export interface IterationInput {
  players: readonly SimulationPlayer[];
  crashBps: bigint;
  lotteryOutcome: LotteryOutcome;
  externalLotteryFunding?: bigint;
}

export interface SimulationTotals {
  freshWagers: bigint;
  grossRake: bigint;
  keeperRewards: bigint;
  burned: bigint;
  communityFunded: bigint;
  crashFounderRake: bigint;
  lotteryGrossConstituted: bigint;
  lotteryFounderFees: bigint;
  lotteryFounderFeesOnRollover: bigint;
  playerCrashPayouts: bigint;
  lotteryWinnerPayouts: bigint;
  consolationPayouts: bigint;
  vaultRemainders: bigint;
  externalLotteryFunding: bigint;
}

export interface LotteryState {
  cycle: bigint;
  epoch: bigint;
  cycleBase: bigint;
  netPrize: bigint;
  pendingFunding: bigint;
  resetReserve: bigint;
  rollover: bigint;
  nextPrizeTarget: bigint;
  awaitingSeal: boolean;
  readyForDraw: boolean;
  highWaterPrize: bigint;
}

export interface SimulationState {
  iteration: bigint;
  protectedPrincipal: bigint;
  emissionBuffer: bigint;
  lottery: LotteryState;
  totals: SimulationTotals;
}

export interface IterationResult {
  state: SimulationState;
  qualified: boolean;
  seed: bigint;
  settlement?: ReturnType<typeof settleParimutuel>;
  lotteryEvent: "none" | "funding" | "sealed" | "miss" | "hit";
}

const ZERO_TOTALS: SimulationTotals = {
  freshWagers: 0n,
  grossRake: 0n,
  keeperRewards: 0n,
  burned: 0n,
  communityFunded: 0n,
  crashFounderRake: 0n,
  lotteryGrossConstituted: 0n,
  lotteryFounderFees: 0n,
  lotteryFounderFeesOnRollover: 0n,
  playerCrashPayouts: 0n,
  lotteryWinnerPayouts: 0n,
  consolationPayouts: 0n,
  vaultRemainders: 0n,
  externalLotteryFunding: 0n,
};

export function validatePolicy(policy: SimulationPolicy): void {
  const bounded = [
    policy.rakeBps,
    policy.keeperRewardBps,
    policy.protectedPrincipalBps,
    policy.lotteryFounderFeeBps,
    policy.lotteryBaseGrowthBps,
  ];
  if (bounded.some((value) => value < 0n || value > BPS)) throw new RangeError("invalid bps policy");
  if (policy.lotteryFounderFeeBps === BPS) throw new RangeError("lottery fee consumes prize");
  if (policy.rakeBps !== 450n) throw new RangeError("simulation requires ratified 4.50% rake");
  if (policy.minimumPlayers < 1 || !Number.isSafeInteger(policy.minimumPlayers)) {
    throw new RangeError("invalid minimum players");
  }
  const amounts = [
    policy.crashSeed,
    policy.emissionBufferCap,
    policy.lotteryInitialBase,
    policy.lotteryMinimumIncrease,
    policy.lotteryMinimumBaseStep,
    policy.consolation,
  ];
  if (amounts.some((value) => value < 0n) || policy.minimumStake <= 0n) {
    throw new RangeError("invalid amount policy");
  }
  if (policy.lotteryInitialBase <= 0n || policy.lotteryMinimumIncrease <= 0n) {
    throw new RangeError("lottery monotonic steps must be positive");
  }
}

export function initialSimulationState(policy: SimulationPolicy): SimulationState {
  validatePolicy(policy);
  return {
    iteration: 0n,
    protectedPrincipal: 0n,
    emissionBuffer: 0n,
    lottery: {
      cycle: 0n,
      epoch: 0n,
      cycleBase: policy.lotteryInitialBase,
      netPrize: 0n,
      pendingFunding: 0n,
      resetReserve: 0n,
      rollover: 0n,
      nextPrizeTarget: policy.lotteryInitialBase,
      awaitingSeal: true,
      readyForDraw: false,
      highWaterPrize: 0n,
    },
    totals: { ...ZERO_TOTALS },
  };
}

function nextCycleBase(base: bigint, policy: SimulationPolicy): bigint {
  const percentageStep = (base * policy.lotteryBaseGrowthBps) / BPS;
  const step = percentageStep > policy.lotteryMinimumBaseStep
    ? percentageStep
    : policy.lotteryMinimumBaseStep;
  return base + step;
}

function sealFromFunding(state: SimulationState, policy: SimulationPolicy): boolean {
  const lottery = state.lottery;
  if (!lottery.awaitingSeal) return false;
  const target = lottery.nextPrizeTarget;
  const requiredGross = minimumLotteryGross(target, policy.lotteryFounderFeeBps);
  const availableGross = lottery.rollover + lottery.pendingFunding;
  if (availableGross < requiredGross) return false;

  const freshUsed = requiredGross - lottery.rollover;
  lottery.pendingFunding -= freshUsed;
  const sealed = sealLotteryEpoch(lottery.rollover, freshUsed, 0n, policy.lotteryFounderFeeBps);
  const feeOnRollover = (lottery.rollover * policy.lotteryFounderFeeBps) / BPS;
  lottery.netPrize = sealed.netPrize;
  lottery.rollover = 0n;
  lottery.awaitingSeal = false;
  lottery.epoch += 1n;
  lottery.highWaterPrize = lottery.netPrize > lottery.highWaterPrize
    ? lottery.netPrize
    : lottery.highWaterPrize;
  state.totals.lotteryGrossConstituted += sealed.gross;
  state.totals.lotteryFounderFees += sealed.founderFee;
  state.totals.lotteryFounderFeesOnRollover += feeOnRollover;
  return true;
}

function fundResetReserve(state: SimulationState, policy: SimulationPolicy): void {
  if (state.lottery.awaitingSeal) return;
  const required = minimumLotteryGross(
    nextCycleBase(state.lottery.cycleBase, policy),
    policy.lotteryFounderFeeBps,
  );
  const missing = required > state.lottery.resetReserve ? required - state.lottery.resetReserve : 0n;
  const moved = state.lottery.pendingFunding < missing ? state.lottery.pendingFunding : missing;
  state.lottery.pendingFunding -= moved;
  state.lottery.resetReserve += moved;
  state.lottery.readyForDraw = state.lottery.resetReserve >= required;
}

function applyLotteryOutcome(
  state: SimulationState,
  policy: SimulationPolicy,
  outcome: LotteryOutcome,
): IterationResult["lotteryEvent"] {
  const sealed = sealFromFunding(state, policy);
  fundResetReserve(state, policy);
  if (outcome === "none") return sealed ? "sealed" : "funding";
  if (!state.lottery.readyForDraw) return sealed ? "sealed" : "funding";

  if (outcome === "miss") {
    const consolation = policy.consolation < state.lottery.netPrize
      ? policy.consolation
      : state.lottery.netPrize;
    state.totals.consolationPayouts += consolation;
    state.lottery.rollover = state.lottery.netPrize - consolation;
    state.lottery.nextPrizeTarget = state.lottery.netPrize + policy.lotteryMinimumIncrease;
    state.lottery.netPrize = 0n;
    state.lottery.awaitingSeal = true;
    state.lottery.readyForDraw = false;
    return "miss";
  }

  state.totals.lotteryWinnerPayouts += state.lottery.netPrize;
  const newBase = nextCycleBase(state.lottery.cycleBase, policy);
  const sealedReset = sealLotteryEpoch(0n, state.lottery.resetReserve, 0n, policy.lotteryFounderFeeBps);
  if (sealedReset.netPrize < newBase) throw new Error("underfunded reset reserve");
  state.totals.lotteryGrossConstituted += sealedReset.gross;
  state.totals.lotteryFounderFees += sealedReset.founderFee;
  state.lottery.cycle += 1n;
  state.lottery.epoch += 1n;
  state.lottery.cycleBase = newBase;
  state.lottery.netPrize = sealedReset.netPrize;
  state.lottery.nextPrizeTarget = state.lottery.netPrize;
  state.lottery.resetReserve = 0n;
  state.lottery.readyForDraw = false;
  state.lottery.highWaterPrize = state.lottery.netPrize > state.lottery.highWaterPrize
    ? state.lottery.netPrize
    : state.lottery.highWaterPrize;
  fundResetReserve(state, policy);
  return "hit";
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
  state.lottery.pendingFunding += external;
  state.totals.externalLotteryFunding += external;

  const qualified = input.players.length >= policy.minimumPlayers
    && input.players.every((player) => player.stake >= policy.minimumStake);
  let settlement: ReturnType<typeof settleParimutuel> | undefined;
  let seed = 0n;
  if (qualified) {
    seed = state.emissionBuffer < policy.crashSeed ? state.emissionBuffer : policy.crashSeed;
    state.emissionBuffer -= seed;
    const stakes = input.players.map((player) => player.stake);
    const economics = roundEconomics(seed, stakes, policy.rakeBps);
    const split = ratifiedRakeSplit(economics.rake, policy.keeperRewardBps);
    settlement = settleParimutuel(policy.allocationRule, economics.distributable, input.crashBps, input.players);

    state.totals.freshWagers += economics.playerPool;
    state.totals.grossRake += split.grossRake;
    state.totals.keeperRewards += split.keeper;
    state.totals.burned += split.burn;
    state.totals.communityFunded += split.community;
    state.totals.crashFounderRake += split.founders;
    state.totals.playerCrashPayouts += settlement.totalPayout;
    state.totals.vaultRemainders += settlement.vaultRemainder;

    const communityReturn = split.community + settlement.vaultRemainder;
    const principal = (communityReturn * policy.protectedPrincipalBps) / BPS;
    state.protectedPrincipal += principal;
    state.emissionBuffer += communityReturn - principal;
    if (state.emissionBuffer > policy.emissionBufferCap) {
      state.lottery.pendingFunding += state.emissionBuffer - policy.emissionBufferCap;
      state.emissionBuffer = policy.emissionBufferCap;
    }
  }

  const lotteryEvent = applyLotteryOutcome(state, policy, input.lotteryOutcome);
  assertSimulationInvariants(prior, state, policy, qualified);
  return { state, qualified, seed, settlement, lotteryEvent };
}

export function accountedAssets(state: SimulationState): bigint {
  return state.protectedPrincipal
    + state.emissionBuffer
    + state.lottery.pendingFunding
    + state.lottery.resetReserve
    + state.lottery.netPrize
    + state.lottery.rollover;
}

export function assertSimulationInvariants(
  prior: SimulationState,
  state: SimulationState,
  policy: SimulationPolicy,
  qualified: boolean,
): void {
  if (state.protectedPrincipal < prior.protectedPrincipal) throw new Error("principal decreased");
  if (state.lottery.cycleBase < prior.lottery.cycleBase) throw new Error("cycle base decreased");
  if (state.lottery.highWaterPrize < prior.lottery.highWaterPrize) throw new Error("high water decreased");
  if (qualified && state.totals.freshWagers <= prior.totals.freshWagers) {
    throw new Error("qualified iteration did not add wagers");
  }
  if (state.lottery.readyForDraw) {
    const required = minimumLotteryGross(nextCycleBase(state.lottery.cycleBase, policy), policy.lotteryFounderFeeBps);
    if (state.lottery.resetReserve < required) throw new Error("draw exposed without reset coverage");
  }
  for (const value of [
    state.protectedPrincipal,
    state.emissionBuffer,
    state.lottery.pendingFunding,
    state.lottery.resetReserve,
    state.lottery.netPrize,
    state.lottery.rollover,
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
