/**
 * Adaptive recrawl delay -- Unified Mesh Continuum build item #4
 * (docs/marketplank/GROK-FINDINGS-unified-maximal-hydration-2026-08-26.md).
 * Search engines schedule recrawl from OBSERVED change rate, not a flat
 * TTL -- a page that changes every hour gets recrawled often, one that
 * hasn't changed in months gets recrawled rarely. Same idea here: a
 * collection whose hydration keeps finding real new tokens/fills stays on
 * a short cycle; one that repeatedly finds nothing new backs off, freeing
 * real archival-frontier budget for genuinely under-explored collections.
 *
 * Honest by construction: the "changed" bit is the exact same
 * isNewToken/isFill signal recordArchivalHydration's real callers already
 * pass after a real write succeeds -- no invented volatility score, no
 * probabilistic estimate, just exponential backoff on repeated "nothing
 * new" and a fast reset the moment something real changes.
 */
export function nextHydrateDelayMs(args: {
  baseTtlMs: number;
  maxTtlMs: number;
  minTtlMs: number;
  consecutiveUnchanged: number;
  changed: boolean;
}): number {
  const { baseTtlMs, maxTtlMs, minTtlMs, consecutiveUnchanged, changed } = args;
  if (changed) {
    return Math.max(minTtlMs, Math.floor(baseTtlMs * 0.5));
  }
  // Double toward max while stable (classic adaptive-recrawl backoff),
  // capped at 8x base so one very old, very stable collection never gets
  // permanently starved past maxTtlMs.
  const factor = Math.min(8, Math.pow(2, Math.min(3, consecutiveUnchanged)));
  return Math.min(maxTtlMs, Math.floor(baseTtlMs * factor));
}

export const ARCHIVAL_RECRAWL_BASE_TTL_MS = 6 * 60 * 60_000; // 6h
export const ARCHIVAL_RECRAWL_MIN_TTL_MS = 30 * 60_000; // 30m
export const ARCHIVAL_RECRAWL_MAX_TTL_MS = 7 * 24 * 60 * 60_000; // 7d
