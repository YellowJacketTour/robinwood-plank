import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * Bounded Blast-Radius Canary (BBRC) enforcement tests -- see
 * docs/marketplank/GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
 * Issue 1 and lib/market/multichain/trading/canary-limits.ts.
 *
 * These run against the real local Postgres store (same convention as
 * test/market/collection-token-store.test.ts), inserting/cleaning up
 * synthetic wallets rather than mocking -- canary-limits.ts is enforcement
 * logic wrapped around a handful of SQL queries, not something worth faking
 * around.
 *
 * FOREIGN_TRADE_CANARY_ENABLED is read once as a top-level constant in
 * lib/constants.ts (same pattern as every other flag in that file), fixed
 * at first import for the life of the process. This file sets it to "true"
 * before its first dynamic import of canary-limits.ts and covers ONLY the
 * enabled path -- see test/market/canary-limits-disabled.test.ts (a
 * separate file, so the test runner gives it its own process) for the
 * disabled-path behavior, which needs the flag false from that file's very
 * first import instead.
 */

const skip = !hasPostgresConfig();

process.env.FOREIGN_TRADE_CANARY_ENABLED = "true";
const canaryLimitsModule = import("../../lib/market/multichain/trading/canary-limits");

function uniqueWallet(label: string): string {
  return `zztest-canary-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function loadCanaryLimits() {
  return canaryLimitsModule;
}

async function cleanupWallet(wallet: string) {
  await postgresQuery(`DELETE FROM canary_fill_ledger WHERE wallet = $1`, [wallet]);
}

test("a trade under every cap is allowed and recorded", { skip }, async () => {
  const { checkAndRecordCanaryLimit, CANARY_CAPS_USD } = await loadCanaryLimits();
  const wallet = uniqueWallet("under-caps");
  try {
    const result = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", 10, "sig-1");
    assert.deepEqual(result, { allowed: true });
    assert.ok(CANARY_CAPS_USD.perTrade >= 10);

    const rows = await postgresQuery<{ usd_notional: string; venue: string; chain: string; tx_ref: string | null }>(
      `SELECT usd_notional, venue, chain, tx_ref FROM canary_fill_ledger WHERE wallet = $1`,
      [wallet]
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(Number(rows.rows[0].usd_notional), 10);
    assert.equal(rows.rows[0].venue, "magiceden");
    assert.equal(rows.rows[0].chain, "solana");
    assert.equal(rows.rows[0].tx_ref, "sig-1");
  } finally {
    await cleanupWallet(wallet);
  }
});

test("a trade exceeding the per-trade cap is rejected and not recorded", { skip }, async () => {
  const { checkAndRecordCanaryLimit, CANARY_CAPS_USD } = await loadCanaryLimits();
  const wallet = uniqueWallet("over-per-trade");
  try {
    const result = await checkAndRecordCanaryLimit(
      wallet,
      "magiceden",
      "solana",
      CANARY_CAPS_USD.perTrade + 1
    );
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /per-trade cap exceeded/);

    const rows = await postgresQuery(`SELECT 1 FROM canary_fill_ledger WHERE wallet = $1`, [wallet]);
    assert.equal(rows.rowCount, 0);
  } finally {
    await cleanupWallet(wallet);
  }
});

test("a wallet's cumulative 24h total exceeding its cap is rejected on the Nth trade even though each individual trade was under the per-trade cap", { skip }, async () => {
  const { checkAndRecordCanaryLimit, CANARY_CAPS_USD } = await loadCanaryLimits();
  const wallet = uniqueWallet("wallet-24h");
  try {
    // Use a per-trade amount comfortably under the per-trade cap so only the
    // wallet's rolling 24h cap can be the thing that trips.
    const perTradeAmount = Math.min(CANARY_CAPS_USD.perTrade, CANARY_CAPS_USD.perWallet24h / 2 - 1);
    assert.ok(perTradeAmount > 0, "test setup assumes perWallet24h is comfortably larger than one trade");

    let lastResult;
    let trades = 0;
    // Keep trading until the wallet cap finally rejects one -- bounds the
    // loop so a misconfigured cap can't spin forever.
    for (let i = 0; i < 50; i += 1) {
      lastResult = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", perTradeAmount, `sig-${i}`);
      trades += 1;
      if (!lastResult.allowed) break;
    }

    assert.ok(lastResult && !lastResult.allowed, "wallet 24h cap should eventually reject a trade");
    assert.match((lastResult as { reason: string }).reason, /per-wallet 24h cap exceeded/);
    assert.ok(trades > 1, "at least one trade should have been accepted before the cap tripped");

    const rows = await postgresQuery<{ usd_notional: string }>(
      `SELECT usd_notional FROM canary_fill_ledger WHERE wallet = $1`,
      [wallet]
    );
    // Exactly (trades - 1) rows recorded: every accepted trade wrote a row,
    // the final rejecting trade did not.
    assert.equal(rows.rowCount, trades - 1);
  } finally {
    await cleanupWallet(wallet);
  }
});

test("the global 24h cap independently rejects even a fresh wallet once the aggregate is exhausted", { skip }, async () => {
  const { checkAndRecordCanaryLimit, CANARY_CAPS_USD } = await loadCanaryLimits();
  const spenderWallet = uniqueWallet("global-spender");
  const freshWallet = uniqueWallet("global-fresh");
  try {
    // Directly seed the ledger with a single row totaling the FULL global
    // cap. This bypasses checkAndRecordCanaryLimit's own per-wallet cap
    // (which is smaller than the global cap by design) -- that's fine here,
    // this is test setup via direct SQL, not a claim that one real wallet
    // could legitimately reach this total through the enforced path.
    await postgresQuery(
      `INSERT INTO canary_fill_ledger (wallet, venue, chain, usd_notional) VALUES ($1, 'magiceden', 'solana', $2)`,
      [spenderWallet, CANARY_CAPS_USD.global24h]
    );

    const result = await checkAndRecordCanaryLimit(freshWallet, "unisat", "bitcoin", 1);
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /global 24h cap exceeded/);

    const rows = await postgresQuery(`SELECT 1 FROM canary_fill_ledger WHERE wallet = $1`, [freshWallet]);
    assert.equal(rows.rowCount, 0, "the rejected fresh-wallet trade must not be recorded");
  } finally {
    await cleanupWallet(spenderWallet);
    await cleanupWallet(freshWallet);
  }
});

test("per-venue buckets are global (across wallets) and independent: exhausting BTC does not block Solana for a fresh wallet", { skip }, async () => {
  const { checkAndRecordCanaryLimit, CANARY_CAPS_USD } = await loadCanaryLimits();
  // Per-venue caps are aggregate buckets across every wallet trading that
  // venue/chain (the research doc's "BTC $500/day, Sol $500/day" -- the
  // implementation's rollingSum for the venue check has no wallet filter).
  // Seed the exhausting row under a DIFFERENT wallet from the one under
  // test, otherwise the seed row would also count toward the test wallet's
  // OWN per-wallet cap (200, smaller than the 500 venue cap) and trip that
  // check first instead of the one this test targets.
  const seedWallet = uniqueWallet("per-venue-seed");
  const wallet = uniqueWallet("per-venue");
  try {
    await postgresQuery(
      `INSERT INTO canary_fill_ledger (wallet, venue, chain, usd_notional) VALUES ($1, 'unisat', 'bitcoin', $2)`,
      [seedWallet, CANARY_CAPS_USD.perVenue24h]
    );

    const btcResult = await checkAndRecordCanaryLimit(wallet, "unisat", "bitcoin", 1);
    assert.equal(btcResult.allowed, false);
    assert.match((btcResult as { reason: string }).reason, /per-venue 24h cap exceeded \(unisat\/bitcoin\)/);

    const solResult = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", 1);
    assert.equal(solResult.allowed, true, "a different venue/chain bucket must be unaffected");
  } finally {
    await cleanupWallet(seedWallet);
    await cleanupWallet(wallet);
  }
});

test("invalid inputs are rejected without touching the ledger", { skip }, async () => {
  const { checkAndRecordCanaryLimit } = await loadCanaryLimits();
  const wallet = uniqueWallet("invalid-input");
  try {
    const zero = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", 0);
    assert.equal(zero.allowed, false);

    const negative = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", -5);
    assert.equal(negative.allowed, false);

    const blankWallet = await checkAndRecordCanaryLimit("   ", "magiceden", "solana", 1);
    assert.equal(blankWallet.allowed, false);

    const rows = await postgresQuery(`SELECT 1 FROM canary_fill_ledger WHERE wallet = $1`, [wallet]);
    assert.equal(rows.rowCount, 0);
  } finally {
    await cleanupWallet(wallet);
  }
});
