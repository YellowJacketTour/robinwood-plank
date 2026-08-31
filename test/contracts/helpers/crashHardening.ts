/**
 * Phase 3 hardening (spec docs/marketplank/SPEC-CRASH-GO-LIVE-HARDENING.md)
 * added seven REQUIRED fields to PlankCrashDrand's Config struct. These are
 * the TEST-FIXTURE defaults, and (review MED-3) they ARE the spec's §6
 * PROPOSED production values, so every suite exercises the caps and
 * circuits that would actually ship instead of a "never binds" config that
 * hid arithmetic. They remain PROPOSED, not ratified -- ratification lives
 * in the spec, deploy values in scripts/deploy-casino.ts. A suite whose
 * purpose is a specific formula (e.g. the Vault's num/den draw) overrides
 * the field it needs, explicitly, at its own call site.
 */
export const HARDENING_TEST_DEFAULTS = {
  keeperRevealBps: 100n, // (c) 1% of rake to the revealer -- PROPOSED
  keeperLockBps: 100n, // (c) 1% of rake to the locker -- PROPOSED
  seedMaxBps: 500n, // (b) <= 5% of the bankroll per round -- PROPOSED (ceiling 1000 in bytecode)
  singlePayoutCapBps: 200n, // (b) 2% of reserveAtLock house-side per wallet -- PROPOSED
  dailyDrawdownBps: 1500n, // (b) 15%/24h halts subsidy -- PROPOSED
  hwmDrawdownBps: 5000n, // (b) 50% from high-water halts subsidy -- PROPOSED
  // Re-review NEW-1: the seed-income budget. The fixture default is
  // deliberately LARGE (not the proposed reserveCap/10): every other suite
  // tests a seed FORMULA (num/den draw, seedMaxBps, drawdown circuits) that
  // assumes the Vault can seed before any rake exists, and the proposed
  // 0.2 ETH bootstrap would clip those seeds to 0 and hide the arithmetic
  // under test. The income bound itself is exercised, at the PROPOSED
  // value, by colludingAbsorberIsNotProfitable / seedBoundedByHouseIncome,
  // which override this at their own call sites.
  seedBootstrapBudgetWei: 10n ** 24n, // 1,000,000 ETH: budget effectively off (fixture cap is 0 = uncapped)
  // Keeper-liveness gas floor: OFF by default (pure bps, the farm-proof permissionless
  // fallback / private-alpha posture). A suite testing the designated floor overrides these.
  designatedKeeper: "0x0000000000000000000000000000000000000000",
  keeperFloorWei: 0n,
  keeperEpochBudgetWei: 0n,
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

/// Mirror of PlankCrashDrand._splitPayout (review HIGH-1 + hardening (b).2):
/// (paid, excess) for a winner with weights (w, pw) of totals (W, PW).
export function splitPayout(a: {
  w: bigint;
  pw: bigint;
  W: bigint;
  PW: bigint;
  distributable: bigint;
  seed: bigint;
  reserveAtLock: bigint;
  singlePayoutCapBps: bigint;
}): { paid: bigint; excess: bigint; seedRaw: bigint; seedPaid: bigint } {
  const playerPot = a.distributable > a.seed ? a.distributable - a.seed : 0n;
  let paid = (playerPot * a.w) / a.W;
  if (a.seed === 0n) return { paid, excess: 0n, seedRaw: 0n, seedPaid: 0n };
  const seedRaw = a.PW > 0n ? (a.seed * a.pw) / a.PW : (a.seed * a.w) / a.W;
  let seedPaid = seedRaw > a.pw ? a.pw : seedRaw;
  const cap = (a.reserveAtLock * a.singlePayoutCapBps) / 10000n;
  if (seedPaid > cap) seedPaid = cap;
  paid += seedPaid;
  return { paid, excess: seedRaw - seedPaid, seedRaw, seedPaid };
}

/// (stake*mult/10000, stake*(mult-10000)/10000) at `elapsed` blocks.
export function weightsAt(stake: bigint, elapsed: number | bigint): { w: bigint; pw: bigint } {
  const m = multiplierAt(elapsed);
  return { w: (stake * m) / 10000n, pw: (stake * (m - 10000n)) / 10000n };
}
