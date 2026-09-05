import { createHash } from "node:crypto";
import type { SimulationPolicy, SimulationState } from "@/lib/casino/simulation";
import { msToReachMultiplierBps, multiplierBpsAtMs } from "@/lib/playtest-live-shared";

export const PLAYTEST_RULES_SCHEMA = "plank.live-lab.v1";

export const DEFAULT_PLAYTEST_POLICY: SimulationPolicy = {
  rakeBps: 450n,
  rakeFloorBps: 250n,
  rakeStepBps: 25n,
  rakeVolumeStep: 25_000_000n,
  keeperRewardBps: 0n,
  // Explicit laboratory hypotheses. These are intentionally not described as
  // ratified mainnet parameters.
  protectedPrincipalBps: 5_000n,
  // Playtest test-credit profile (owner decision 2026-09-03, see
  // docs/marketplank/RATIFICATION-ccs2l-2026-09-02.md "Playtest test-credit
  // profile"): 65% of the community leg funds the Powerboard prize, the other
  // 35% is retained (50/50 protected principal / emission buffer) so the vault
  // visibly compounds. Mainnet/ratified economics are untouched by this value.
  powerboardFundingBps: 6_500n,
  crashSeed: 10_000n,
  emissionBufferCap: 1_000_000n,
  lotteryFounderFeeBps: 1_000n,
  // 50,000-credit base: funded gate = minimumLotteryGross(50,000, 10% fee)
  // = 55,555 gross; reachable in the laboratory at minimum stakes. The prior
  // 1,000,000 base (1,111,111 gross) was unreachable at ~11-22 credits/round.
  lotteryInitialBase: 50_000n,
  lotteryMinimumIncrease: 50_000n,
  lotteryBaseGrowthBps: 500n,
  lotteryMinimumBaseStep: 50_000n,
  consolation: 0n,
  allocationRule: "ccs-2l",
  minimumPlayers: 2,
  // 500 credits = 0.0005 ETH, about $1.22 at the current public reference.
  // Test credits have no cash value; this is a conservative UX analogue.
  minimumStake: 500n,
};

/** Prize-profile tuples the public laboratory has shipped, oldest first. A
 * stored room policy equal to one of these is advanced to the DEFAULT at the
 * next round boundary (never mid-flight); see startPlaytestRound. */
export const PLAYTEST_PRIZE_PROFILES = {
  // 2026-08 legacy: 25% of the community leg, 100k base.
  v1: { powerboardFundingBps: 2_500n, lotteryInitialBase: 100_000n, lotteryMinimumIncrease: 1_000n, lotteryBaseGrowthBps: 100n, lotteryMinimumBaseStep: 1_000n },
  // 2026-09-02 ratification-era default: full community leg, 1M base.
  v2: { powerboardFundingBps: 10_000n, lotteryInitialBase: 1_000_000n, lotteryMinimumIncrease: 50_000n, lotteryBaseGrowthBps: 500n, lotteryMinimumBaseStep: 50_000n },
} as const;
export const PLAYTEST_PRIZE_PROFILE_KEYS = ["powerboardFundingBps", "lotteryInitialBase", "lotteryMinimumIncrease", "lotteryBaseGrowthBps", "lotteryMinimumBaseStep"] as const;
export const CURRENT_PLAYTEST_PRIZE_PROFILE = "v3";

/** Which superseded prize profile a stored policy carries, or null when it
 * already matches the current default (or is a bespoke host edit). */
export function legacyPlaytestPrizeProfile(policy: SimulationPolicy): keyof typeof PLAYTEST_PRIZE_PROFILES | null {
  for (const [name, profile] of Object.entries(PLAYTEST_PRIZE_PROFILES) as Array<[keyof typeof PLAYTEST_PRIZE_PROFILES, Record<string, bigint>]>) {
    if (PLAYTEST_PRIZE_PROFILE_KEYS.every((key) => policy[key] === profile[key])) return name;
  }
  return null;
}

/** Round-boundary lottery re-basing that accompanies a prize-profile upgrade.
 * Only an UNSEALED, undisplayed target is lowered: nothing has been promised
 * (netPrize 0, no rollover, no armed draw) and the cycle base still sits at
 * the superseded profile's initial base. Funding already accrued
 * (pendingFunding, resetReserve, principal) is never touched, so accounted
 * assets are conserved exactly. Returns null when nothing is eligible. */
export function rebasePlaytestLotteryTarget(state: SimulationState, fromInitialBase: bigint, toInitialBase: bigint): SimulationState | null {
  const lottery = state.lottery;
  if (fromInitialBase === toInitialBase) return null;
  if (!lottery.awaitingSeal || lottery.readyForDraw || lottery.netPrize !== 0n || lottery.rollover !== 0n) return null;
  if (lottery.cycleBase !== fromInitialBase || lottery.nextPrizeTarget !== fromInitialBase) return null;
  return { ...state, lottery: { ...lottery, cycleBase: toInitialBase, nextPrizeTarget: toInitialBase } };
}

/**
 * A settled table advances exactly once when the first participant commits.
 * Once a lobby exists, every other participant must join that same round.
 * Incrementing for every bet makes alternating clients continually invalidate
 * one another's seats (guest opens N+1, host opens N+2, guest opens N+3).
 */
export function bettingRoundId(phase: "lobby" | "running" | "settled", currentRound: bigint): bigint {
  if (phase === "running") throw new RangeError("betting is closed");
  if (phase === "settled") return currentRound + 1n;
  return currentRound > 0n ? currentRound : 1n;
}

/** A newly joined human gets one minimum-stake, manual-lock seat on the next
 * launch so following an invite actually enters the shared flight. This is
 * deliberately not recurring auto-bet: later wagers require player intent. */
export function newcomerSeatPlan(balance: bigint, minimumStake: bigint) {
  if (minimumStake <= 0n || balance < minimumStake) return null;
  return { stake: minimumStake, targetBps: 20_000n, autoLockEnabled: false } as const;
}

export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function playtestRulesHash(policy: SimulationPolicy): string {
  return createHash("sha256")
    .update(canonicalJson({ schema: PLAYTEST_RULES_SCHEMA, policy }))
    .digest("hex");
}

const POLICY_BIGINT_KEYS = new Set([
  "rakeBps", "rakeFloorBps", "rakeStepBps", "rakeVolumeStep",
  "keeperRewardBps", "protectedPrincipalBps", "crashSeed",
  "emissionBufferCap", "lotteryFounderFeeBps", "lotteryInitialBase",
  "lotteryMinimumIncrease", "lotteryBaseGrowthBps", "lotteryMinimumBaseStep",
  "consolation", "minimumStake", "powerboardFundingBps",
]);

export function parsePolicy(raw: unknown): SimulationPolicy {
  const value = raw as Record<string, unknown>;
  const revived: Record<string, unknown> = { ...value };
  for (const key of POLICY_BIGINT_KEYS) {
    const fallback = key in DEFAULT_PLAYTEST_POLICY
      ? DEFAULT_PLAYTEST_POLICY[key as keyof SimulationPolicy]
      : undefined;
    revived[key] = BigInt(String(value[key] ?? fallback));
  }
  return revived as unknown as SimulationPolicy;
}

const STATE_BIGINT_KEYS = new Set([
  "iteration", "protectedPrincipal", "emissionBuffer", "cycle", "epoch",
  "cycleBase", "netPrize", "pendingFunding", "resetReserve", "rollover",
  "nextPrizeTarget", "highWaterPrize", "freshWagers", "grossRake",
  "keeperRewards", "burned", "communityFunded", "powerboardFunded", "crashFounderRake",
  "lotteryGrossConstituted", "lotteryFounderFees", "lotteryFounderFeesOnRollover",
  "playerCrashPayouts", "lotteryWinnerPayouts", "consolationPayouts",
  "vaultRemainders", "externalLotteryFunding", "flightSeeded",
]);

export function parseSimulationState(raw: unknown): SimulationState {
  const revive = (value: unknown, key = ""): unknown => {
    if (STATE_BIGINT_KEYS.has(key)) return BigInt(String(value));
    if (Array.isArray(value)) return value.map((child) => revive(child));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, revive(child, childKey)]));
    }
    return value;
  };
  const state = revive(raw) as SimulationState;
  // Snapshots produced before per-round Powerboard provenance was introduced
  // remain replayable; absence means no historically attributed contribution.
  state.totals.powerboardFunded ??= 0n;
  state.totals.flightSeeded ??= 0n;
  return state;
}

const EDITABLE_SIMULATION_AMOUNTS = new Set([
  "protectedPrincipal", "emissionBuffer",
  "lottery.cycleBase", "lottery.netPrize", "lottery.highWaterPrize",
  "lottery.pendingFunding", "lottery.resetReserve", "lottery.rollover", "lottery.nextPrizeTarget",
  "totals.burned", "totals.communityFunded", "totals.crashFounderRake", "totals.lotteryFounderFees",
]);
const EDITABLE_SIMULATION_FLAGS = new Set(["lottery.awaitingSeal", "lottery.readyForDraw"]);

export function injectSimulationState(current: SimulationState, patch: unknown): SimulationState {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RangeError("Simulation changes must be an object.");
  const state = parseSimulationState(serializeBigInts(current)) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!EDITABLE_SIMULATION_AMOUNTS.has(path) && !EDITABLE_SIMULATION_FLAGS.has(path)) throw new RangeError(`${path} cannot be injected.`);
    const [parent, child] = path.split(".");
    const target = child ? state[parent] as Record<string, unknown> : state;
    if (!target || typeof target !== "object") throw new RangeError(`${path} is unavailable.`);
    if (EDITABLE_SIMULATION_FLAGS.has(path)) {
      if (typeof value !== "boolean") throw new RangeError(`${path} must be true or false.`);
      target[child] = value;
    } else {
      if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new RangeError(`${path} must be a non-negative integer string.`);
      target[child || parent] = BigInt(value);
    }
  }
  const lottery = state.lottery as Record<string, unknown>;
  if (lottery.awaitingSeal && lottery.readyForDraw) throw new RangeError("A lottery cannot await sealing and be ready for a draw simultaneously.");
  if (lottery.readyForDraw && BigInt(String(lottery.netPrize)) <= 0n) throw new RangeError("A draw-ready lottery needs a positive prize.");
  if (BigInt(String(lottery.highWaterPrize)) < BigInt(String(lottery.netPrize))) lottery.highWaterPrize = lottery.netPrize;
  if (BigInt(String(lottery.cycleBase)) <= 0n || BigInt(String(lottery.nextPrizeTarget)) <= 0n) throw new RangeError("Lottery bases and targets must stay positive.");
  return state as unknown as SimulationState;
}

export function simulationCrashBps(revealHex: string): bigint {
  if (!/^[0-9a-f]{64}$/.test(revealHex)) throw new RangeError("invalid reveal");
  let digest = revealHex;
  const space = 1n << 256n;
  const limit = space - (space % 10_000n);
  let sample = BigInt(`0x${digest}`);
  // Rejection sampling removes even the vanishing 2^256 modulo bias. Rehashing
  // is deterministic and domain-local; it cannot be selected after commit.
  while (sample >= limit) {
    digest = createHash("sha256").update(digest, "hex").digest("hex");
    sample = BigInt(`0x${digest}`);
  }
  const bucket = sample % 10_000n;
  // Same inverse-survival species as the ratified crash contracts:
  // P(crash >= x) ~= 1/x, discretized to bps, with a genuine 10,000x tail.
  // Rake remains an explicit pool allocation rather than hidden RNG edge.
  return bucket === 0n ? 10_000n : 100_000_000n / (10_000n - bucket);
}

export const PLAYTEST_POWERBOARD_ODDS = 16;

/** Exact integer presentation quote for a linear-weight two-stage voucher.
 * This never enters settlement; it makes the already-ratified probability
 * visible without floating-point drift or a wallet-based Sybil bonus. */
export function powerboardVoucherQuote(myWeight: bigint, totalWeight: bigint, netPrize: bigint, hitOddsOneIn = PLAYTEST_POWERBOARD_ODDS) {
  if (myWeight < 0n || totalWeight < 0n || netPrize < 0n || myWeight > totalWeight) throw new RangeError("invalid voucher quote amounts");
  if (!Number.isSafeInteger(hitOddsOneIn) || hitOddsOneIn < 1) throw new RangeError("invalid hit odds");
  const odds = BigInt(hitOddsOneIn);
  return {
    conditionalSharePpm: totalWeight > 0n ? myWeight * 1_000_000n / totalWeight : 0n,
    combinedOddsOneInCeil: myWeight > 0n ? (totalWeight * odds + myWeight - 1n) / myWeight : 0n,
    probabilityWeightedPrize: totalWeight > 0n ? netPrize * myWeight / (totalWeight * odds) : 0n,
  };
}

/** Public, deterministic numbered draw derived from the already-committed reveal. */
export function powerboardRoundDraw(revealHex: string) {
  if (!/^[0-9a-f]{64}$/.test(revealHex)) throw new RangeError("invalid reveal");
  const digest = createHash("sha256").update(`${revealHex}:powerboard:number`).digest();
  const drawnNumber = digest.readUInt32BE(0) % PLAYTEST_POWERBOARD_ODDS + 1;
  return { drawnNumber, winningNumber: 1, oddsOneIn: PLAYTEST_POWERBOARD_ODDS, rawHit: drawnNumber === 1 };
}

/** Flight duration until the committed crash multiplier, via the ONE shared
 * inverse of M(t) in lib/playtest-live-shared. */
export function crashDurationMs(crashBps: bigint): number {
  return Math.max(350, msToReachMultiplierBps(Number(crashBps)));
}

/** Authoritative multiplier at a server instant, via the ONE shared M(t). */
export function multiplierAt(startedAtMs: number, nowMs: number): bigint {
  return BigInt(multiplierBpsAtMs(nowMs - startedAtMs));
}

/** Settlement target authority:
 * - an accepted live lock always wins precedence;
 * - an explicitly armed auto-lock may execute its precommitted target;
 * - a merely visible/manual target is not an action and must crash out. */
export function effectiveSettlementTarget(
  crashBps: bigint,
  requestedTargetBps: bigint,
  acceptedTargetBps: bigint | null,
  autoLockEnabled: boolean,
): bigint {
  // A pre-committed auto target is a ceiling, never a suggestion that a
  // later manual request may raise. Manual play can improve safety only by
  // locking earlier. (The on-chain PlankCrash has no manual lock at all: a
  // seat commits its target at bet time.)
  if (autoLockEnabled) {
    if (acceptedTargetBps !== null && acceptedTargetBps < requestedTargetBps) return acceptedTargetBps;
    return requestedTargetBps;
  }
  if (acceptedTargetBps !== null) return acceptedTargetBps;
  return crashBps + 1n;
}

export function serializeBigInts(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child));
}
