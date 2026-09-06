import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { edgeKey, edgeRead, readEdgeStats, resetEdgeStats, EDGE_POLICY } from "../../lib/market/multichain/edge/read-gateway";
import { flushProviderLedger, readProviderLedger, recordExternalCall, outcomeForResponse } from "../../lib/market/multichain/edge/provider-ledger";

/**
 * The Single Point, proven rather than claimed: N concurrent readers of one
 * cell must cost ONE vendor fetch. Runs against the real local Postgres
 * (same `{ skip: !hasPostgresConfig() }` pattern as
 * singleflight-cache-budget.test.ts) because the coalescing lease and the
 * cache both live there -- an in-memory mock would prove nothing about
 * cross-process behavior.
 */

async function clearKey(key: string) {
  await postgresQuery(`DELETE FROM plank_kv_values WHERE key_name = $1 OR key_name = $2`, [
    `plank:singleflight:${key}`,
    `plank:singleflight:${key}:lease`,
  ]);
}

test("edgeKey normalizes EVM addresses and sorts variants so two routes collide on purpose", () => {
  const a = edgeKey({ kind: "owned", chainSlug: "eth-mainnet", subject: "0xABCDEF0000000000000000000000000000000001", variant: { b: 2, a: 1 } });
  const b = edgeKey({ kind: "owned", chainSlug: "eth-mainnet", subject: "0xabcdef0000000000000000000000000000000001", variant: { a: 1, b: 2 } });
  assert.equal(a, b);
  assert.equal(a, "edge:owned:eth-mainnet:0xabcdef0000000000000000000000000000000001:a=1&b=2");
  // Non-EVM identities are case-sensitive (Helius mints, ME symbols) and must not be lower-cased.
  assert.equal(edgeKey({ kind: "tokens", chainSlug: "solana-mainnet", subject: "MintABC" }), "edge:tokens:solana-mainnet:MintABC");
});

test("every EdgeKind has a policy with soft < hard TTL", () => {
  for (const [kind, p] of Object.entries(EDGE_POLICY)) {
    assert.ok(p.softTtlMs > 0 && p.hardTtlMs > p.softTtlMs, `${kind} policy must have 0 < soft < hard`);
  }
});

test(
  "N=50 concurrent readers of one cold cell -> exactly 1 fetcher invocation; a second wave inside soft TTL -> 0",
  { skip: !hasPostgresConfig() },
  async () => {
    const cell = { kind: "listings" as const, chainSlug: "zztest-chain", subject: `zztest-${Date.now()}`, variant: { limit: 24 } };
    const key = edgeKey(cell);
    await clearKey(key);
    resetEdgeStats();
    let fetches = 0;
    const fetcher = async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 120)); // a real vendor round-trip takes time; this is what makes coalescing matter
      return { book: [1, 2, 3], at: Date.now() };
    };
    try {
      const wave1 = await Promise.all(Array.from({ length: 50 }, () => edgeRead(cell, fetcher)));
      assert.equal(fetches, 1, "50 concurrent readers must collapse into ONE vendor fetch");
      assert.ok(wave1.every((r) => r.value.book.length === 3));

      const wave2 = await Promise.all(Array.from({ length: 50 }, () => edgeRead(cell, fetcher)));
      assert.equal(fetches, 1, "readers inside the soft TTL must cost zero vendor fetches");
      assert.ok(wave2.every((r) => r.freshness === "cached"));

      const stats = readEdgeStats();
      const listings = stats.byKind.find((k) => k.kind === "listings");
      assert.ok(listings);
      assert.equal(listings!.reads, 100);
      assert.equal(listings!.fetches, 1);
      assert.equal(listings!.uniqueCells, 1);
      assert.equal(listings!.fetchesPerCell, 1);
      assert.equal(listings!.readsPerFetch, 100);
    } finally {
      await clearKey(key);
    }
  }
);

test(
  "a thrown fetcher never poisons the cache and is recorded as an error in the ledger",
  { skip: !hasPostgresConfig() },
  async () => {
    const cell = { kind: "activity" as const, chainSlug: "zztest-chain", subject: `zztest-err-${Date.now()}` };
    const key = edgeKey(cell);
    await clearKey(key);
    try {
      await assert.rejects(edgeRead(cell, async () => { throw new Error("vendor 503"); }));
      const cached = await postgresQuery(`SELECT 1 FROM plank_kv_values WHERE key_name = $1`, [`plank:singleflight:${key}`]);
      assert.equal(cached.rows.length, 0, "no value may be cached for a failed fetch");
      await flushProviderLedger();
      const rows = await readProviderLedger(2);
      const row = rows.find((r) => r.source === "edge:activity" && r.chainSlug === "zztest-chain");
      assert.ok(row, "the failed fetch must appear in the durable ledger");
      assert.ok(row!.errors >= 1);
    } finally {
      await clearKey(key);
      await postgresQuery(`DELETE FROM plank_provider_ledger WHERE chain_slug = 'zztest-chain'`);
    }
  }
);

test("outcomeForResponse classifies real vendor statuses", () => {
  assert.equal(outcomeForResponse(200), "ok");
  assert.equal(outcomeForResponse(429), "rate_limited");
  assert.equal(outcomeForResponse(403), "error");
  assert.equal(outcomeForResponse(403, { treat403AsRateLimit: true }), "rate_limited");
  assert.equal(outcomeForResponse(500), "error");
});

test(
  "provider ledger: records are summed per (source,key,chain,minute) and survive a flush",
  { skip: !hasPostgresConfig() },
  async () => {
    await postgresQuery(`DELETE FROM plank_provider_ledger WHERE source = 'zztest-vendor'`);
    try {
      recordExternalCall({ source: "zztest-vendor", keyId: "key-0", chainSlug: "base-mainnet", latencyMs: 100, outcome: "ok", costUnits: 3 });
      recordExternalCall({ source: "zztest-vendor", keyId: "key-0", chainSlug: "base-mainnet", latencyMs: 300, outcome: "rate_limited", httpStatus: 429, error: "HTTP 429" });
      await flushProviderLedger();
      const rows = await readProviderLedger(2);
      const row = rows.find((r) => r.source === "zztest-vendor");
      assert.ok(row);
      assert.equal(row!.calls, 2);
      assert.equal(row!.ok, 1);
      assert.equal(row!.rateLimited, 1);
      assert.equal(row!.costUnits, 4);
      assert.equal(row!.avgLatencyMs, 200);
      assert.equal(row!.maxLatencyMs, 300);
      assert.equal(row!.lastError, "HTTP 429");
      assert.equal(row!.keyId, "key-0");
    } finally {
      await postgresQuery(`DELETE FROM plank_provider_ledger WHERE source = 'zztest-vendor'`);
    }
  }
);
