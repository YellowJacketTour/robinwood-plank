import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import {
  widenTtl,
  recordProviderCall,
  isProviderBudgetExhausted,
  readProviderBudget,
  getEffectiveTtl,
  PROVIDER_BUDGET_DEFAULTS,
} from "../../lib/market/multichain/freshness-budget";

/**
 * Freshness Budget Controller -- docs/marketplank/GROK-FINDINGS-biggest-
 * issues-unified-vision-2026-08-25.md "Issue 2". Formula tests are pure
 * (no I/O). Budget-state tests run against the real local Postgres this
 * app already uses in dev/CI (same `{ skip: !hasPostgresConfig() }` +
 * real-insert-and-cleanup pattern test/market/collection-token-store.test.ts
 * established for this exact "thin SQL wrapper with no logic to fake
 * around" reasoning) -- never mocked, per this session's live-verify
 * discipline for the singleflight cache layer FBC sits on top of.
 */

test("widenTtl is a no-op at zero pressure", () => {
  assert.equal(widenTtl(60_000, 0), 60_000);
});

test("widenTtl matches the doc's worked example: k=3, full soft ceiling (pressure=1) widens to ~4x base", () => {
  const base = 60_000;
  const widened = widenTtl(base, 1);
  // TTL_eff = base * (1 + 3 * 1^2) = base * 4, but MAX_TTL_MULTIPLIER caps at 4x too,
  // so this should land exactly at 4x (240_000ms), matching "TTL ~= 4x base".
  assert.equal(widened, base * 4);
});

test("widenTtl grows with the square of pressure, not linearly", () => {
  const base = 10_000;
  const at50 = widenTtl(base, 0.5);
  const at100 = widenTtl(base, 1.0);
  // At p=0.5: base * (1 + 3*0.25) = base * 1.75
  assert.equal(at50, base * 1.75);
  // Going from p=0.5 to p=1.0 (2x pressure) more than doubles the widening
  // amount above base (1.75x -> 4x is +2.25x of base, not +1.75x again) --
  // this is the quadratic shape the doc explicitly calls for, distinguishing
  // FBC from a naive linear backoff.
  const growth50 = at50 - base;
  const growth100 = at100 - base;
  assert.ok(growth100 > growth50 * 2, `expected superlinear growth: ${growth50} -> ${growth100}`);
});

test("widenTtl never widens past pressure=1 -- exhaustion is handled by the hard ceiling, not an unbounded TTL", () => {
  const base = 60_000;
  assert.equal(widenTtl(base, 1), widenTtl(base, 5));
  assert.equal(widenTtl(base, 1), widenTtl(base, 100));
});

test("widenTtl respects the absolute cap (30 min) even for a large base TTL", () => {
  const oneHourBase = 60 * 60_000;
  const widened = widenTtl(oneHourBase, 1);
  assert.ok(widened <= 30 * 60_000, `expected <= 30min cap, got ${widened}ms`);
});

test("PROVIDER_BUDGET_DEFAULTS: every listed provider's soft ceiling is strictly below its hard ceiling", () => {
  for (const [provider, { softCeiling, hardCeiling }] of Object.entries(PROVIDER_BUDGET_DEFAULTS)) {
    assert.ok(softCeiling > 0, `${provider} soft ceiling must be positive`);
    assert.ok(softCeiling < hardCeiling, `${provider} soft ceiling (${softCeiling}) must be below hard ceiling (${hardCeiling})`);
  }
});

async function cleanupBudget(provider: string) {
  await postgresQuery(`DELETE FROM plank_provider_budget WHERE provider = $1`, [provider]);
}

test(
  "recordProviderCall increments calls_used for the current window, and readProviderBudget reports real pressure",
  { skip: !hasPostgresConfig() },
  async () => {
    const provider = "zztest-fbc-basic";
    await cleanupBudget(provider);
    try {
      const before = await readProviderBudget(provider);
      assert.equal(before.callsUsed, 0, "a never-called provider starts at 0");
      assert.equal(before.exhausted, false);

      await recordProviderCall(provider);
      await recordProviderCall(provider);
      await recordProviderCall(provider);

      const after = await readProviderBudget(provider);
      assert.equal(after.callsUsed, 3);
      // Fallback ceilings apply since "zztest-fbc-basic" isn't a real provider.
      assert.equal(after.pressure, 3 / after.softCeiling);
    } finally {
      await cleanupBudget(provider);
    }
  }
);

test(
  "isProviderBudgetExhausted flips true once calls_used reaches hard ceiling, and getEffectiveTtl widens as pressure rises",
  { skip: !hasPostgresConfig() },
  async () => {
    const provider = "zztest-fbc-exhaustion";
    await cleanupBudget(provider);
    try {
      assert.equal(await isProviderBudgetExhausted(provider), false);

      const budget = await readProviderBudget(provider);
      const baseTtl = 60_000;
      const ttlAtZeroPressure = await getEffectiveTtl(provider, baseTtl);
      assert.equal(ttlAtZeroPressure, baseTtl, "no calls yet -- TTL unwidened");

      // Drive calls_used up to (but not past) the soft ceiling.
      for (let i = 0; i < budget.softCeiling; i++) {
        await recordProviderCall(provider);
      }
      const ttlAtSoftCeiling = await getEffectiveTtl(provider, baseTtl);
      assert.ok(ttlAtSoftCeiling > ttlAtZeroPressure, "TTL must widen once spend reaches the soft ceiling");
      assert.equal(await isProviderBudgetExhausted(provider), false, "soft ceiling alone must not exhaust the budget");

      // Drive the remaining calls up to the hard ceiling.
      const remaining = budget.hardCeiling - budget.softCeiling;
      for (let i = 0; i < remaining; i++) {
        await recordProviderCall(provider);
      }
      assert.equal(await isProviderBudgetExhausted(provider), true, "hard ceiling reached -- budget must report exhausted");
    } finally {
      await cleanupBudget(provider);
    }
  }
);

test(
  "each provider gets its own independent window -- exhausting one provider does not affect another",
  { skip: !hasPostgresConfig() },
  async () => {
    const providerA = "zztest-fbc-isolation-a";
    const providerB = "zztest-fbc-isolation-b";
    await cleanupBudget(providerA);
    await cleanupBudget(providerB);
    try {
      // The budget is a fixed 60 s window. In CI the 90 sequential writes
      // below can straddle a window boundary, splitting the spend across
      // two windows so neither reaches the ceiling (seen live 2026-09-06 as
      // a spurious "expected true, actual false"). Start at a safe distance
      // from the boundary.
      const WINDOW_MS = 60_000;
      const remaining = WINDOW_MS - (Date.now() % WINDOW_MS);
      if (remaining < 15_000) await new Promise((r) => setTimeout(r, remaining + 250));
      const budgetA = await readProviderBudget(providerA);
      for (let i = 0; i < budgetA.hardCeiling; i++) await recordProviderCall(providerA);
      assert.equal(await isProviderBudgetExhausted(providerA), true);
      assert.equal(await isProviderBudgetExhausted(providerB), false, "provider B must be unaffected by provider A's spend");
    } finally {
      await cleanupBudget(providerA);
      await cleanupBudget(providerB);
    }
  }
);
