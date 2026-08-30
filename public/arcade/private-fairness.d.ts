export function privateCrashBpsFromReveal(revealHex: string): Promise<bigint>;
export function verifyPrivateRound(input: {
  commitment: string;
  reveal: string;
  crashBps: string | number | bigint;
}): Promise<{
  verified: boolean;
  commitmentMatches: boolean;
  crashMatches: boolean;
  derivedCrashBps: bigint | null;
}>;
