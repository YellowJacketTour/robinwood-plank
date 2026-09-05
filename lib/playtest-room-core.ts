import { createHash } from "node:crypto";
import { PROB_ONE, type SimulationPolicy, type SimulationState } from "@/lib/casino/simulation";
import { msToReachMultiplierBps, multiplierBpsAtMs } from "@/lib/playtest-live-shared";

export const PLAYTEST_RULES_SCHEMA = "plank.live-lab.v2";

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
  // profile"): 65% of the community leg funds the lottery prize, the other
  // 35% is retained (50/50 protected principal / emission buffer) so the vault
  // visibly compounds. Mainnet/ratified economics are untouched by this value.
  powerboardFundingBps: 6_500n,
  crashSeed: 10_000n,
  emissionBufferCap: 1_000_000n,
  lotteryFounderFeeBps: 1_000n,
  // The lottery law (2026-09-05, RESEARCH-game-theory-lottery-seed-resolution):
  // the SAME parameters the contracts deploy with. Flat ceiling 1 in 16;
  // kappa = 2 (the pool keeps at least half of every contribution in
  // expectation); progressive carve x(P) = 10% + 20% * P / (P + 250,000 cr).
  lotteryOddsOneIn: 16n,
  lotteryKappaBps: 20_000n,
  carveMinBps: 1_000n,
  carveMaxBps: 3_000n,
  carveHalfSaturation: 250_000n,
  allocationRule: "ccs-2l",
  minimumPlayers: 2,
  // 500 credits = 0.0005 ETH, about $1.22 at the current public reference.
  // Test credits have no cash value; this is a conservative UX analogue.
  minimumStake: 500n,
};

export const CURRENT_PLAYTEST_PRIZE_PROFILE = "v4-actuarial";
/** The lottery-law keys a stored policy must carry to be current. */
export const PLAYTEST_PRIZE_PROFILE_KEYS = ["powerboardFundingBps", "lotteryOddsOneIn", "lotteryKappaBps", "carveMinBps", "carveMaxBps", "carveHalfSaturation"] as const;
/** Superseded stored-policy keys (the cycle-base / reset-reserve / must-hit model). */
export const LEGACY_LOTTERY_POLICY_KEYS = ["lotteryInitialBase", "lotteryMinimumIncrease", "lotteryBaseGrowthBps", "lotteryMinimumBaseStep", "consolation"] as const;

/** A stored policy written by the pre-actuarial engine (any of the v1/v2/v3
 * cycle-base profiles) is advanced to the current default at the next round
 * boundary (never mid-flight); see startPlaytestRound. Returns the legacy
 * profile name, or null when the policy already carries the current law. */
export function legacyPlaytestPrizeProfile(raw: unknown): "pre-actuarial" | null {
  const stored = (raw ?? {}) as Record<string, unknown>;
  const missingCurrent = PLAYTEST_PRIZE_PROFILE_KEYS.some((key) => stored[key] === undefined);
  const carriesLegacy = LEGACY_LOTTERY_POLICY_KEYS.some((key) => stored[key] !== undefined);
  return missingCurrent || carriesLegacy ? "pre-actuarial" : null;
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
  "emissionBufferCap", "lotteryFounderFeeBps",
  "lotteryOddsOneIn", "lotteryKappaBps", "carveMinBps", "carveMaxBps", "carveHalfSaturation",
  "minimumStake", "powerboardFundingBps",
]);

/** Revive a stored policy. Unknown (legacy) keys are dropped; missing current
 * keys take the laboratory default, so a pre-actuarial room parses into a
 * valid current policy (its rules hash then changes at the round boundary). */
export function parsePolicy(raw: unknown): SimulationPolicy {
  const value = raw as Record<string, unknown>;
  const revived: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_PLAYTEST_POLICY)) {
    revived[key] = value[key] ?? DEFAULT_PLAYTEST_POLICY[key as keyof SimulationPolicy];
  }
  for (const key of POLICY_BIGINT_KEYS) revived[key] = BigInt(String(revived[key]));
  revived.minimumPlayers = Number(revived.minimumPlayers);
  return revived as unknown as SimulationPolicy;
}

const STATE_BIGINT_KEYS = new Set([
  "iteration", "protectedPrincipal", "emissionBuffer",
  "pool", "committedPrize", "draws", "hits", "highWaterPrize", "lastThresholdE18", "lastContribution",
  "freshWagers", "grossRake",
  "keeperRewards", "burned", "communityFunded", "powerboardFunded", "crashFounderRake",
  "lotteryGrossConstituted", "lotteryFounderFees", "lotterySeeded",
  "playerCrashPayouts", "lotteryWinnerPayouts",
  "vaultRemainders", "externalLotteryFunding", "flightSeeded",
  // legacy lottery shape (migrated below)
  "cycle", "epoch", "cycleBase", "netPrize", "pendingFunding", "resetReserve", "rollover", "nextPrizeTarget",
  "lotteryFounderFeesOnRollover", "consolationPayouts",
]);

/** Founder fee the pre-actuarial engine had NOT yet charged on money still
 * sitting in its gross buckets (pendingFunding, resetReserve). */
const LEGACY_FOUNDER_FEE_BPS = 1_000n;

/**
 * Migrate a pre-actuarial lottery snapshot (cycleBase / netPrize / rollover /
 * pendingFunding / resetReserve) to the pool model, conserving accounted
 * assets exactly: everything already net (netPrize, rollover) joins the pool
 * as is; the gross buckets are charged the founder fee they would have paid
 * at their seal and join net. The whole pool is immediately drawable.
 */
export function migrateLegacyLotteryState(state: Record<string, unknown>): void {
  const lottery = state.lottery as Record<string, unknown> | undefined;
  if (!lottery || lottery.pool !== undefined || lottery.netPrize === undefined) return;
  const big = (key: string) => BigInt(String(lottery[key] ?? "0"));
  const gross = big("pendingFunding") + big("resetReserve");
  const fee = (gross * LEGACY_FOUNDER_FEE_BPS) / 10_000n;
  const pool = big("netPrize") + big("rollover") + gross - fee;
  const totals = (state.totals ??= {}) as Record<string, unknown>;
  totals.lotteryFounderFees = (BigInt(String(totals.lotteryFounderFees ?? "0")) + fee).toString();
  totals.lotteryGrossConstituted = (BigInt(String(totals.lotteryGrossConstituted ?? "0")) + gross).toString();
  totals.lotterySeeded ??= "0";
  const highWater = big("highWaterPrize");
  state.lottery = {
    pool: pool.toString(),
    committedPrize: pool.toString(),
    draws: "0",
    hits: String(lottery.cycle ?? "0"),
    highWaterPrize: (highWater > pool ? highWater : pool).toString(),
    lastThresholdE18: "0",
    lastContribution: "0",
  };
}

export function parseSimulationState(raw: unknown): SimulationState {
  const plain = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  migrateLegacyLotteryState(plain);
  const revive = (value: unknown, key = ""): unknown => {
    if (STATE_BIGINT_KEYS.has(key)) return BigInt(String(value));
    if (Array.isArray(value)) return value.map((child) => revive(child));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .map(([childKey, child]) => [childKey, revive(child, childKey)]));
    }
    return value;
  };
  const state = revive(plain) as SimulationState;
  // Snapshots produced before per-round lottery provenance was introduced
  // remain replayable; absence means no historically attributed contribution.
  state.totals.powerboardFunded ??= 0n;
  state.totals.flightSeeded ??= 0n;
  state.totals.lotterySeeded ??= 0n;
  state.lottery.draws ??= 0n;
  state.lottery.hits ??= 0n;
  state.lottery.lastThresholdE18 ??= 0n;
  state.lottery.lastContribution ??= 0n;
  return state;
}

const EDITABLE_SIMULATION_AMOUNTS = new Set([
  "protectedPrincipal", "emissionBuffer",
  "lottery.pool", "lottery.committedPrize", "lottery.highWaterPrize",
  "totals.burned", "totals.communityFunded", "totals.crashFounderRake", "totals.lotteryFounderFees",
]);

export function injectSimulationState(current: SimulationState, patch: unknown): SimulationState {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new RangeError("Simulation changes must be an object.");
  const state = parseSimulationState(serializeBigInts(current)) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!EDITABLE_SIMULATION_AMOUNTS.has(path)) throw new RangeError(`${path} cannot be injected.`);
    const [parent, child] = path.split(".");
    const target = child ? state[parent] as Record<string, unknown> : state;
    if (!target || typeof target !== "object") throw new RangeError(`${path} is unavailable.`);
    if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new RangeError(`${path} must be a non-negative integer string.`);
    target[child || parent] = BigInt(value);
  }
  const lottery = state.lottery as Record<string, unknown>;
  // Injecting a pool alone makes it the next prize (mirrors a funded, settled board).
  if ((patch as Record<string, unknown>)["lottery.pool"] !== undefined && (patch as Record<string, unknown>)["lottery.committedPrize"] === undefined) {
    lottery.committedPrize = lottery.pool;
  }
  if (BigInt(String(lottery.committedPrize)) > BigInt(String(lottery.pool))) throw new RangeError("The committed prize cannot exceed the pool.");
  if (BigInt(String(lottery.highWaterPrize)) < BigInt(String(lottery.pool))) lottery.highWaterPrize = lottery.pool;
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

/** The lottery machine shows this many balls; ball 1 is the winning zone. */
export const PLAYTEST_POWERBOARD_BALLS = 16;

/**
 * Public, deterministic uniform draw derived from the already-committed
 * reveal: `sampleE18` in [0, PROB_ONE) is what the engine compares against
 * the round's actuarial threshold (hit iff sample < threshold). `drawnNumber`
 * is the presentation ball (1..16) the sample lands in; ball 1 is the
 * winning zone at the flat ceiling, and inside it the exact threshold decides.
 */
export function powerboardRoundDraw(revealHex: string) {
  if (!/^[0-9a-f]{64}$/.test(revealHex)) throw new RangeError("invalid reveal");
  let digest = createHash("sha256").update(`${revealHex}:powerboard:number`).digest("hex");
  const space = 1n << 256n;
  const limit = space - (space % PROB_ONE);
  let sample = BigInt(`0x${digest}`);
  while (sample >= limit) {
    digest = createHash("sha256").update(digest, "hex").digest("hex");
    sample = BigInt(`0x${digest}`);
  }
  const sampleE18 = sample % PROB_ONE;
  const drawnNumber = Number((sampleE18 * BigInt(PLAYTEST_POWERBOARD_BALLS)) / PROB_ONE) + 1;
  return { sampleE18, drawnNumber, balls: PLAYTEST_POWERBOARD_BALLS, winningNumber: 1 };
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
