import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";

/**
 * Bounded Blast-Radius Canary (BBRC) kill-switch test -- see
 * lib/market/multichain/trading/canary-limits.ts's module header for the
 * documented "always return allowed: false" kill-switch behavior.
 *
 * Split into its own file (rather than living alongside
 * test/market/canary-limits.test.ts's enabled-path tests) because
 * FOREIGN_TRADE_CANARY_ENABLED is a module-level constant in
 * lib/constants.ts, fixed at first import for the life of the process --
 * this file sets it to "false" before its own first dynamic import so that
 * value actually takes effect, and relies on the test runner giving each
 * test FILE its own process (true for `tsx --test` / `node --test` given
 * multiple file args) so this file's "false" can never be clobbered by the
 * other file's "true" or vice versa.
 */

const skip = !hasPostgresConfig();

test("canary disabled: checkAndRecordCanaryLimit always rejects with a clear reason and writes nothing", { skip }, async () => {
  process.env.FOREIGN_TRADE_CANARY_ENABLED = "false";
  const { checkAndRecordCanaryLimit } = await import(
    "../../lib/market/multichain/trading/canary-limits"
  );
  const wallet = `zztest-canary-disabled-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const result = await checkAndRecordCanaryLimit(wallet, "magiceden", "solana", 10);
    assert.deepEqual(result, { allowed: false, reason: "canary disabled" });

    const rows = await postgresQuery(`SELECT 1 FROM canary_fill_ledger WHERE wallet = $1`, [wallet]);
    assert.equal(rows.rowCount, 0, "disabled canary must not write to the ledger");
  } finally {
    await postgresQuery(`DELETE FROM canary_fill_ledger WHERE wallet = $1`, [wallet]);
  }
});
