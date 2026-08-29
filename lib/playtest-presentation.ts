export type PlaytestPhase = "lobby" | "running" | "settled";
export type CommandStatus = "submitting" | "accepted" | "rejected" | "unknown";

export type VisibleCommand = {
  id: string;
  action: string;
  status: CommandStatus;
  message: string;
  sequence?: string;
};

export function presentedMultiplierBps(input: {
  phase: PlaytestPhase;
  liveBps: number | null;
  crashBps: string | null;
  deadlinePassed: boolean;
}): number {
  const crash = input.crashBps ? Number(input.crashBps) : 10_000;
  if (input.phase === "settled" || input.deadlinePassed) return crash;
  if (input.phase === "running") return Math.min(input.liveBps ?? 10_000, crash);
  return 10_000;
}

export function signedNet(stake: string, payout: string | null): bigint | null {
  if (payout === null) return null;
  return BigInt(payout) - BigInt(stake);
}

export function connectionState(lastSuccessAt: number | null, now: number): "idle" | "live" | "delayed" | "offline" {
  if (lastSuccessAt === null) return "idle";
  const age = now - lastSuccessAt;
  // The authoritative update endpoint intentionally holds a quiet request for
  // up to 20 seconds. Freshness thresholds must sit beyond that normal window.
  if (age > 45_000) return "offline";
  if (age > 25_000) return "delayed";
  return "live";
}
