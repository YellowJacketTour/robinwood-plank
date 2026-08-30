import { createHash } from "node:crypto";

export const BOT_PROFILE_NAMES = ["cautious", "balanced", "bold", "whale", "house-money", "break-even", "wildcard"] as const;
export type BotProfileName = typeof BOT_PROFILE_NAMES[number];

export type PlaytestBotProfile = {
  preset: BotProfileName;
  enabled: boolean;
  initialBankroll: string;
  stakeMinBps: number;
  stakeMaxBps: number;
  targetMinBps: number;
  targetMaxBps: number;
};

type Preset = Omit<PlaytestBotProfile, "enabled" | "initialBankroll">;
export const BOT_PRESETS: Record<BotProfileName, Preset> = {
  cautious: { preset: "cautious", stakeMinBps: 100, stakeMaxBps: 350, targetMinBps: 11_000, targetMaxBps: 17_500 },
  balanced: { preset: "balanced", stakeMinBps: 250, stakeMaxBps: 800, targetMinBps: 14_000, targetMaxBps: 30_000 },
  bold: { preset: "bold", stakeMinBps: 500, stakeMaxBps: 1_500, targetMinBps: 20_000, targetMaxBps: 65_000 },
  whale: { preset: "whale", stakeMinBps: 1_000, stakeMaxBps: 3_000, targetMinBps: 13_000, targetMaxBps: 38_000 },
  "house-money": { preset: "house-money", stakeMinBps: 300, stakeMaxBps: 1_800, targetMinBps: 15_000, targetMaxBps: 55_000 },
  "break-even": { preset: "break-even", stakeMinBps: 350, stakeMaxBps: 2_000, targetMinBps: 18_000, targetMaxBps: 80_000 },
  wildcard: { preset: "wildcard", stakeMinBps: 100, stakeMaxBps: 2_500, targetMinBps: 10_100, targetMaxBps: 100_000 },
};

export function botProfile(preset: BotProfileName, bankroll: bigint, overrides: Partial<PlaytestBotProfile> = {}): PlaytestBotProfile {
  if (!BOT_PROFILE_NAMES.includes(preset)) throw new RangeError("Unknown bot strategy preset.");
  const profile = { ...BOT_PRESETS[preset], enabled: true, initialBankroll: bankroll.toString(), ...overrides };
  validateBotProfile(profile);
  return profile;
}

export function validateBotProfile(value: unknown): asserts value is PlaytestBotProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RangeError("Bot profile must be an object.");
  const p = value as PlaytestBotProfile;
  if (!BOT_PROFILE_NAMES.includes(p.preset) || typeof p.enabled !== "boolean") throw new RangeError("Invalid bot preset or enabled state.");
  if (!/^\d{1,30}$/.test(p.initialBankroll) || BigInt(p.initialBankroll) <= 0n) throw new RangeError("Bot initial bankroll must be positive.");
  for (const key of ["stakeMinBps", "stakeMaxBps", "targetMinBps", "targetMaxBps"] as const) {
    if (!Number.isSafeInteger(p[key])) throw new RangeError(`${key} must be an integer.`);
  }
  if (p.stakeMinBps < 1 || p.stakeMaxBps > 10_000 || p.stakeMinBps > p.stakeMaxBps) throw new RangeError("Bot stake range is invalid.");
  if (p.targetMinBps < 10_100 || p.targetMaxBps > 1_000_000 || p.targetMinBps > p.targetMaxBps) throw new RangeError("Bot target range is invalid.");
}

function sample(seed: string, lane: string): bigint {
  return BigInt(`0x${createHash("sha256").update(`${seed}:${lane}`).digest("hex").slice(0, 16)}`);
}

function between(seed: string, lane: string, min: number, max: number): number {
  return min + Number(sample(seed, lane) % BigInt(max - min + 1));
}

/** A bot commits from bankroll and public history only. The seed deliberately
 * excludes the unrevealed crash secret, so synthetic actors have no oracle. */
export function botRoundCommitment(input: {
  roomId: string; roundId: bigint; botId: string; bankroll: bigint; minimumStake: bigint; profile: PlaytestBotProfile;
}): { stake: bigint; targetBps: bigint } | null {
  const { bankroll, minimumStake, profile } = input;
  validateBotProfile(profile);
  if (!profile.enabled || bankroll < minimumStake) return null;
  const seed = `${input.roomId}:${input.roundId}:${input.botId}:${profile.preset}`;
  let stakeBps = between(seed, "stake", profile.stakeMinBps, profile.stakeMaxBps);
  const initial = BigInt(profile.initialBankroll);
  if (profile.preset === "house-money" && bankroll > initial) stakeBps = Math.min(10_000, Math.floor(stakeBps * 1.5));
  if (profile.preset === "break-even" && bankroll < initial) stakeBps = Math.min(10_000, Math.floor(stakeBps * 1.6));
  let stake = bankroll * BigInt(stakeBps) / 10_000n;
  if (stake < minimumStake) stake = minimumStake;
  if (stake > bankroll) stake = bankroll;

  // Log-space sampling prevents a wide range from clustering at extreme
  // numerical targets while retaining a long-tail of ambitious commitments.
  const u = between(seed, "target", 0, 1_000_000) / 1_000_000;
  const target = Math.round(Math.exp(Math.log(profile.targetMinBps) + u * (Math.log(profile.targetMaxBps) - Math.log(profile.targetMinBps))));
  return { stake, targetBps: BigInt(target) };
}

export function weightedTicketWinner<T extends { id: string; weight: bigint }>(tickets: readonly T[], entropy: string): T | null {
  const eligible = tickets.filter((ticket) => ticket.weight > 0n);
  const total = eligible.reduce((sum, ticket) => sum + ticket.weight, 0n);
  if (!total) return null;
  const space = 1n << 256n;
  if (total >= space) throw new RangeError("Ticket range exceeds the laboratory entropy space.");
  const ceiling = space - space % total;
  let draw = 0n;
  for (let counter = 0; counter < 128; counter += 1) {
    draw = BigInt(`0x${createHash("sha256").update(`${entropy}:${counter}`).digest("hex")}`);
    if (draw < ceiling) break;
    if (counter === 127) throw new RangeError("Could not obtain an unbiased ticket draw.");
  }
  const ticket = draw % total;
  let cursor = 0n;
  for (const candidate of eligible) {
    cursor += candidate.weight;
    if (ticket < cursor) return candidate;
  }
  throw new RangeError("Weighted ticket draw escaped its range.");
}
