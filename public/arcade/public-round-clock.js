export const PUBLIC_GROWTH_PER_SECOND = 0.22;
export const PUBLIC_IGNITION_MS = 1400;
export function canRepeatPublicRound({storyActive,remainingMs,reviewRemainingMs=0}) {
  return !storyActive && reviewRemainingMs<=0 && Number.isFinite(remainingMs) && remainingMs >= 8000;
}
export function publicFlightDuration(endBps) {
  if (!Number.isFinite(endBps) || endBps < 10000 || endBps > 100000000) throw new RangeError('Invalid crash');
  return Math.log(endBps / 10000) / PUBLIC_GROWTH_PER_SECOND * 1000;
}
export function publicFlightAt(elapsedMs, endBps) {
  const duration = publicFlightDuration(endBps);
  const flightMs = Math.max(0, elapsedMs - PUBLIC_IGNITION_MS);
  return { multiplier: Math.min(endBps / 10000, Math.exp(PUBLIC_GROWTH_PER_SECOND * flightMs / 1000)), complete: elapsedMs >= PUBLIC_IGNITION_MS + duration };
}
export function canCommitPublicRound({phase, deadlineMs, nowMs, freshAtMs, pending}) {
  return phase === 0 && !pending && Number.isFinite(deadlineMs) && nowMs < deadlineMs && nowMs - freshAtMs < 8000;
}
