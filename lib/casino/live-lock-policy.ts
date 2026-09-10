/** Research kernel, NOT a deployed live-cashout protocol or receipt verifier. */
export const PULSE_Q = 1n << 256n;
export function pulseOutcome(previousBps: bigint, nextBps: bigint, entropy: bigint) {
  if(previousBps < 10000n || nextBps <= previousBps || nextBps > 100000000n || entropy < 0n || entropy >= PULSE_Q) throw new RangeError('Invalid pulse');
  // Conditional inverse-uniform tail: Pr(C >= x | C >= previous) = previous/x.
  // Rounding at most one 256-bit sample per threshold; zero denotes the tail.
  const crashBps = entropy === 0n ? 100000000n : previousBps * PULSE_Q / entropy;
  return {survived:crashBps >= nextBps, crashBps:crashBps > 100000000n ? 100000000n : crashBps};
}
export type LiveLockIntent = {
  round: bigint; pulse: bigint; multiplierBps: bigint; nonce: bigint; deadlineMs: number;
};
export type LiveLockState = {
  round: bigint; pulse: bigint; verifiedMultiplierBps: bigint; nonce: bigint;
  cutoffMs: number; entropyNotBeforeMs: number; finalityMarginMs: number;
  // Supplied by a separately verified canonical inclusion proof, NEVER a client timestamp.
  canonicalIncludedAtMs: number; canonicalFinalizedAtMs: number;
  anchorVerified: boolean; locked: boolean; crashed: boolean;
};
export function rejectLiveLock(intent: LiveLockIntent, state: LiveLockState): string | null {
  if(!state.anchorVerified) return 'unverified-inclusion';
  if(state.locked || state.crashed) return 'closed';
  if(intent.round !== state.round || intent.pulse !== state.pulse) return 'wrong-window';
  if(intent.nonce !== state.nonce) return 'replayed-intent';
  if(intent.multiplierBps !== state.verifiedMultiplierBps) return 'unverified-price';
  const times=[intent.deadlineMs,state.cutoffMs,state.entropyNotBeforeMs,state.finalityMarginMs,state.canonicalIncludedAtMs,state.canonicalFinalizedAtMs];
  if(times.some(t=>!Number.isSafeInteger(t)||t<0)) return 'invalid-clock';
  if(intent.deadlineMs > state.cutoffMs || state.canonicalIncludedAtMs >= intent.deadlineMs) return 'expired';
  if(state.canonicalFinalizedAtMs < state.canonicalIncludedAtMs) return 'invalid-anchor';
  if(state.canonicalFinalizedAtMs + state.finalityMarginMs >= state.entropyNotBeforeMs) return 'entropy-race';
  return null;
}
