export const PRIVATE_LIVE_GROWTH_PER_SECOND: number;
export class PrivateLiveClock {
  constructor(growthPerSecond?: number);
  roundKey: string | null;
  lastBps: number;
  reset(): void;
  synchronize(input: {
    roundKey: string;
    version: string;
    phase: string;
    startedAt: string | null;
    crashAt: string | null;
    serverNow: string;
  }, receivedPerfMs: number): boolean;
  sample(perfMs: number): number;
}
