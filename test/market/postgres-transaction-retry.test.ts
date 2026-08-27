import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, withPostgresTransaction } from "../../lib/postgres";

/**
 * Real gap found live 2026-08-27: a genuine Postgres deadlock (40P01,
 * surfaced by the new, much higher real concurrency across OpenSea and
 * HyperSync lanes) used to bubble all the way up as a hard, unretried
 * failure -- mesh-lane.ts's own top-level catch just logged
 * "[mesh-lane] fatal deadlock detected" and exited 1, discarding a whole
 * lane's real work. Postgres's own docs say the correct response to a
 * deadlock or serialization failure is simply to retry the same
 * transaction. This proves withPostgresTransaction now does that itself,
 * for every real caller, without each one needing its own retry logic.
 */
test(
  "withPostgresTransaction retries a deadlock/serialization error and eventually succeeds",
  { skip: !hasPostgresConfig() },
  async () => {
    let attempts = 0;
    const result = await withPostgresTransaction(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("deadlock detected") as Error & { code: string };
        err.code = "40P01";
        throw err;
      }
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(attempts, 3, "must retry exactly until the deadlock clears, not stop at the first failure");
  }
);

test(
  "withPostgresTransaction does not retry a real, non-transient error",
  { skip: !hasPostgresConfig() },
  async () => {
    let attempts = 0;
    await assert.rejects(
      withPostgresTransaction(async () => {
        attempts += 1;
        const err = new Error("column \"nope\" does not exist") as Error & { code: string };
        err.code = "42703";
        throw err;
      }),
      /does not exist/
    );
    assert.equal(attempts, 1, "a genuine query error must fail immediately, never be mistaken for transient contention");
  }
);
