export const PUBLIC_GROWTH_PER_SECOND = 0.22;
export const PUBLIC_IGNITION_MS = 1400;
// Repeat plays EVERY round it can reach. A bet on the hosted table lands in
// ~4.5s (send + inclusion + the arcade's own confirmation), so 5s of betting
// left is enough. The old 8s minimum, stacked on an 8s post-lottery review
// hold, skipped every third round (measured on plank.love: 4 of 12 rounds
// with 9-19s of betting open and no bet) -- and a skipped round is a crash
// with no scorecard, which read as the card 'sometimes not showing'.
export const REPEAT_MIN_REMAINING_MS = 5000;
export function canRepeatPublicRound({storyActive,remainingMs,reviewRemainingMs=0}) {
  return !storyActive && reviewRemainingMs<=0 && Number.isFinite(remainingMs) && remainingMs >= REPEAT_MIN_REMAINING_MS;
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
