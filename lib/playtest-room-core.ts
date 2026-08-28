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

export function simulationCrashBps(revealHex: string): bigint {
  if (!/^[0-9a-f]{64}$/.test(revealHex)) throw new RangeError("invalid reveal");
  const sample = BigInt(`0x${revealHex.slice(0, 16)}`);
  // Laboratory coverage distribution only: 1.00x..100.00x. Production uses
  // the ratified committed randomness mapping, never this helper.
  return 10_000n + sample % 990_001n;
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
