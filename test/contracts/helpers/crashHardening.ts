/**
 * Phase 3 hardening (spec docs/marketplank/SPEC-CRASH-GO-LIVE-HARDENING.md)
 * added seven REQUIRED fields to PlankCrashDrand's Config struct. These are
 * the TEST-FIXTURE defaults: chosen so every pre-existing suite keeps its
 * exact pre-hardening arithmetic (no effective seed cap below what num/den
 * already gives, no payout cap bite, circuits that cannot trip, and a max
 * multiplier equal to what maxElapsedBlocks already implied). They are NOT
 * the spec's proposed production values -- see scripts/deploy-casino.ts.
 */
export const HARDENING_TEST_DEFAULTS = {
  keeperRevealBps: 0n,
  keeperLockBps: 0n,
  seedMaxBps: 5000n, // == SEED_MAX_BPS_CEILING; every fixture uses num/den <= 1/2
  singlePayoutCapBps: 10000n, // cap = 100% of reserveAtLock: never binds under fixtures
  dailyDrawdownBps: 10000n, // a >100% drawdown is impossible: never trips
  hwmDrawdownBps: 10000n, // reserve < 0 is impossible: never trips
};

/// Mirror of PlankCrashDrand._multiplierAt (pure, integer): 10000 + 40e + e^2/5.
export function multiplierAt(elapsedBlocks: number | bigint): bigint {
  const e = BigInt(elapsedBlocks);
  return 10000n + e * 40n + (e * e) / 5n;
}

/// Hardening config for a fixture whose block cap is `maxElapsedBlocks`:
/// the explicit max multiplier is set to exactly what that block cap already
/// implied, so maxMultiplierElapsedBlocks == maxElapsedBlocks.
export function hardeningFor(maxElapsedBlocks: number | bigint) {
  return { ...HARDENING_TEST_DEFAULTS, maxMultiplierBps: multiplierAt(maxElapsedBlocks) };
}
