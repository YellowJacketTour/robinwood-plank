export const PRIVATE_LIVE_GROWTH_PER_SECOND: number;
export function privateCurveDurationSeconds(endBps: number, growthPerSecond?: number): number;
export class PrivateLiveClock {
  constructor(growthPerSecond?: number, maxPredictionLeadMs?: number);
  roundKey: string | null;
  lastBps: number;
  deadlinePerfMs: number | null;
  reset(): void;
  synchronize(input: {
    roundKey: string;
    version: string;
    phase: string;
    startedAt: string | null;
    crashAt: string | null;
    serverNow: string;
    displayLagMs?: number;
  }, receivedPerfMs: number): boolean;
  sample(perfMs: number): number;
  isPredictionHeld(perfMs: number): boolean;
}
