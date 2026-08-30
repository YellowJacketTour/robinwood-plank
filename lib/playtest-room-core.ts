import { createHash } from "node:crypto";
import type { SimulationPolicy, SimulationState } from "@/lib/casino/simulation";
import { LIVE_GROWTH_PER_SECOND } from "@/lib/playtest-live-shared";

export const PLAYTEST_RULES_SCHEMA = "plank.live-lab.v1";

export const DEFAULT_PLAYTEST_POLICY: SimulationPolicy = {
  rakeBps: 450n,
  keeperRewardBps: 0n,
  // Explicit laboratory hypotheses. These are intentionally not described as
  // ratified mainnet parameters.
  protectedPrincipalBps: 5_000n,
  crashSeed: 10_000n,
  emissionBufferCap: 1_000_000n,
  lotteryFounderFeeBps: 1_000n,
  lotteryInitialBase: 100_000n,
  lotteryMinimumIncrease: 1_000n,
  lotteryBaseGrowthBps: 100n,
  lotteryMinimumBaseStep: 1_000n,
  consolation: 0n,
  allocationRule: "pfss",
  minimumPlayers: 2,
  minimumStake: 100n,
};

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
  "rakeBps", "keeperRewardBps", "protectedPrincipalBps", "crashSeed",
  "emissionBufferCap", "lotteryFounderFeeBps", "lotteryInitialBase",
  "lotteryMinimumIncrease", "lotteryBaseGrowthBps", "lotteryMinimumBaseStep",
  "consolation", "minimumStake",
]);

export function parsePolicy(raw: unknown): SimulationPolicy {
  const value = raw as Record<string, unknown>;
  const revived: Record<string, unknown> = { ...value };
  for (const key of POLICY_BIGINT_KEYS) revived[key] = BigInt(String(value[key]));
  return revived as unknown as SimulationPolicy;
}

const STATE_BIGINT_KEYS = new Set([
  "iteration", "protectedPrincipal", "emissionBuffer", "cycle", "epoch",
  "cycleBase", "netPrize", "pendingFunding", "resetReserve", "rollover",
  "nextPrizeTarget", "highWaterPrize", "freshWagers", "grossRake",
  "keeperRewards", "burned", "communityFunded", "crashFounderRake",
  "lotteryGrossConstituted", "lotteryFounderFees", "lotteryFounderFeesOnRollover",
  "playerCrashPayouts", "lotteryWinnerPayouts", "consolationPayouts",
  "vaultRemainders", "externalLotteryFunding",
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
  return revive(raw) as SimulationState;
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

export function crashDurationMs(crashBps: bigint): number {
  const multiplier = Number(crashBps) / 10_000;
  return Math.max(350, Math.ceil(Math.log(multiplier) / LIVE_GROWTH_PER_SECOND * 1_000));
}

export function multiplierAt(startedAtMs: number, nowMs: number): bigint {
  const elapsedSeconds = Math.max(0, nowMs - startedAtMs) / 1_000;
  return BigInt(Math.floor(10_000 * Math.exp(LIVE_GROWTH_PER_SECOND * elapsedSeconds)));
}

export function serializeBigInts(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "bigint" ? child.toString() : child));
}
