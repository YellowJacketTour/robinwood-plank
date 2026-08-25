import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { durableKv } from "../../lib/market/durable-kv";
import { getOrRefreshWithMeta } from "../../lib/market/multichain/singleflight-cache";
import { recordProviderCall, readProviderBudget } from "../../lib/market/multichain/freshness-budget";

/**
 * Real-Postgres verification that the Freshness Budget Controller's hard
 * ceiling behaves exactly per docs/marketplank/GROK-FINDINGS-biggest-
 * issues-unified-vision-2026-08-25.md "Issue 2", step 5: "If calls_used >=
 * hard_ceiling: do not call upstream. Serve last cache if present ... with
 * freshness: stale_budget. If no cache: fail closed with explicit
 * provider_budget_exhausted (never fabricate)." Also verifies this is
 * consistent with (not a regression of) singleflight-cache.ts's pre-
 * existing "never discard cache on transient failure" rule.
 *
 * Runs against the real local Postgres this app already uses -- same
 * `{ skip: !hasPostgresConfig() }` pattern as
 * test/market/collection-token-store.test.ts -- with real rows inserted
 * and cleaned up, never mocked.
 */

async function deleteCacheEntry(cacheKey: string): Promise<void> {
  const fullKey = `plank:singleflight:${cacheKey}`;
  await postgresQuery(`DELETE FROM plank_kv_values WHERE key_name = $1 OR key_name = $2`, [
    fullKey,
    `${fullKey}:lease`,
  ]);
}

async function cleanup(provider: string, cacheKey: string) {
  await postgresQuery(`DELETE FROM plank_provider_budget WHERE provider = $1`, [provider]);
  await deleteCacheEntry(cacheKey);
}

async function exhaust(provider: string) {
  const budget = await readProviderBudget(provider);
  for (let i = 0; i < budget.hardCeiling; i++) await recordProviderCall(provider);
}

test(
  "hard ceiling hit + cache exists -> serves stale cache labeled stale_budget, never calls upstream",
  { skip: !hasPostgresConfig() },
  async () => {
    const provider = "zztest-sfc-stale";
    const cacheKey = "zztest-sfc-stale-key";
    await cleanup(provider, cacheKey);
    try {
      // Seed a real cached value directly via durableKv, as if a prior
      // request had already populated it.
      await durableKv.set(`plank:singleflight:${cacheKey}`, { value: "seeded-value", cachedAt: Date.now() - 999_000 });

      await exhaust(provider);

      let upstreamCalls = 0;
      const result = await getOrRefreshWithMeta<string>(
        cacheKey,
        { softTtlMs: 1_000, hardTtlMs: 2_000, provider },
        async () => {
          upstreamCalls += 1;
          return "fresh-value-should-not-be-fetched";
        }
      );

      assert.equal(upstreamCalls, 0, "upstream must never be called once the hard ceiling is hit");
      assert.equal(result.value, "seeded-value", "must serve the existing cache, not fabricate a value");
      assert.equal(result.freshness, "stale_budget");
    } finally {
      await cleanup(provider, cacheKey);
    }
  }
);

test(
  "hard ceiling hit + no cache at all -> fails closed with provider_budget_exhausted, never fabricates a value",
  { skip: !hasPostgresConfig() },
  async () => {
    const provider = "zztest-sfc-failclosed";
    const cacheKey = "zztest-sfc-failclosed-key";
    await cleanup(provider, cacheKey);
    try {
      await exhaust(provider);

      let upstreamCalls = 0;
      await assert.rejects(
        () =>
          getOrRefreshWithMeta<string>(
            cacheKey,
            { softTtlMs: 1_000, hardTtlMs: 2_000, provider },
            async () => {
              upstreamCalls += 1;
              return "should-never-happen";
            }
          ),
        /provider_budget_exhausted/
      );
      assert.equal(upstreamCalls, 0, "upstream must never be called once the hard ceiling is hit, even with no cache to fall back to");
    } finally {
      await cleanup(provider, cacheKey);
    }
  }
);

test(
  "under budget pressure but below hard ceiling, effective TTL widens so a would-be-hard-TTL-expired cache is still served without a live fetch",
  { skip: !hasPostgresConfig() },
  async () => {
    const provider = "zztest-sfc-widen";
    const cacheKey = "zztest-sfc-widen-key";
    await cleanup(provider, cacheKey);
    try {
      const baseHardTtlMs = 1_000;
      // Cache is 1.5s old -- past the unwidened hard TTL of 1s, so without
      // budget pressure this would trigger a synchronous refresh.
      await durableKv.set(`plank:singleflight:${cacheKey}`, { value: "still-good", cachedAt: Date.now() - 1_500 });

      // Push spend to exactly the soft ceiling (pressure = 1.0), which
      // widens TTL toward ~4x base per the doc's k=3 worked example --
      // comfortably past the 1.5s cache age above.
      const budget = await readProviderBudget(provider);
      for (let i = 0; i < budget.softCeiling; i++) await recordProviderCall(provider);

      let upstreamCalls = 0;
      const result = await getOrRefreshWithMeta<string>(
        cacheKey,
        { softTtlMs: 1, hardTtlMs: baseHardTtlMs, provider },
        async () => {
          upstreamCalls += 1;
          return "freshly-fetched";
        }
      );

      assert.equal(result.value, "still-good");
      assert.equal(result.freshness, "cached");
      // A background refresh may still be kicked off (stale-while-
      // revalidate), but the REQUEST ITSELF must not block on/require a
      // synchronous upstream call -- it already returned the cached value
      // above without awaiting one.
    } finally {
      await cleanup(provider, cacheKey);
    }
  }
);

test(
  "no provider passed -> budget is never consulted, prior behavior fully preserved",
  { skip: !hasPostgresConfig() },
  async () => {
    const cacheKey = "zztest-sfc-no-provider-key";
    await deleteCacheEntry(cacheKey);
    try {
      let upstreamCalls = 0;
      const result = await getOrRefreshWithMeta<string>(
        cacheKey,
        { softTtlMs: 60_000, hardTtlMs: 120_000 },
        async () => {
          upstreamCalls += 1;
          return "value-a";
        }
      );
      assert.equal(upstreamCalls, 1);
      assert.equal(result.value, "value-a");
      assert.equal(result.freshness, "live");
    } finally {
      await deleteCacheEntry(cacheKey);
    }
  }
);
