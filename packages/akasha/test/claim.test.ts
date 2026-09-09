/**
 * Lock-free shard claiming.
 *
 * The planner says which ranges need walking; this decides how N workers
 * divide them with no lock service, no leader, and no partition assignment
 * that goes stale when a worker dies.
 *
 * Two properties carry the whole design, and both are failures that would be
 * invisible in production:
 *
 *   1. two workers must never hold the same shard  -- duplicated work looks
 *      like progress, so nothing would ever report it
 *   2. an abandoned shard must return to the pool  -- otherwise it looks done
 *      and the archive carries a hole nothing revisits, which is exactly the
 *      failure this package exists to refuse
 *
 * The SQL is asserted against its text because the mechanism IS the SQL:
 * `FOR UPDATE SKIP LOCKED` is not an optimisation here, it is the mutual
 * exclusion. A test that only exercised a fake would pass with it removed.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import {
  claimShards,
  enqueueShards,
  releaseShard,
  retireShard,
  CLAIM_LEASE_SEC,
  SHARD_REASON,
  type ClaimSql,
} from "../src/hose/claim.ts";
import { planShards } from "../src/hose/shard.ts";

/** Records every statement so the mechanism can be asserted, not assumed. */
function recordingSql(rows: Record<string, unknown>[] = []): ClaimSql & {
  statements: string[];
  values: unknown[][];
} {
  const self = {
    statements: [] as string[],
    values: [] as unknown[][],
    async query(sql: string, values: unknown[] = []) {
      self.statements.push(sql);
      self.values.push(values);
      return { rows };
    },
  };
  return self;
}

test("claiming uses FOR UPDATE SKIP LOCKED -- the mutual exclusion itself", async () => {
  const sql = recordingSql();
  await claimShards(sql, "bitcoin", 4);
  const stmt = sql.statements[0] ?? "";
  ok(/FOR UPDATE SKIP LOCKED/.test(stmt), "without SKIP LOCKED workers serialise or collide");
  ok(/ORDER BY id/.test(stmt), "an unordered LIMIT hands out arbitrary shards");
  ok(/LIMIT \$4::int/.test(stmt), "the claim must be bounded");
});

test("an expired lease makes a shard claimable again", async () => {
  const sql = recordingSql();
  await claimShards(sql, "bitcoin", 1, 60);
  const stmt = sql.statements[0] ?? "";
  ok(
    /claimed_at IS NULL OR claimed_at < NOW\(\) - /.test(stmt),
    "a worker that died mid-shard must not hold it forever"
  );
  eq(sql.values[0]?.[2], 60, "the lease must be the one the caller asked for");
});

test("a claim is a lease, not a delete", async () => {
  // Deleting on claim would lose the range if the worker died before writing
  // coverage: the shard would look done and the hole would never be revisited.
  const sql = recordingSql();
  await claimShards(sql, "bitcoin", 1);
  const stmt = sql.statements[0] ?? "";
  ok(/UPDATE akasha_gap_queue/.test(stmt), "claiming must stamp the row");
  ok(!/DELETE/.test(stmt), "claiming must not remove it");
  ok(/attempts = g\.attempts \+ 1/.test(stmt), "and must count the attempt");
});

test("a shard is retired only by an explicit call, after its coverage is written", async () => {
  const sql = recordingSql([{ id: "1" }]);
  const ok1 = await retireShard(sql, { chain: "bitcoin", from: 1, to: 2 });
  eq(ok1, true);
  ok(/DELETE FROM akasha_gap_queue/.test(sql.statements[0] ?? ""), "retiring removes the row");
  ok(
    (sql.values[0] ?? []).includes(SHARD_REASON),
    "and is scoped to shard claims, never another job's row"
  );
});

test("retiring a shard that is not there reports false", async () => {
  // A silent success here would let a caller believe it finished work that no
  // row ever represented.
  const sql = recordingSql([]);
  eq(await retireShard(sql, { chain: "bitcoin", from: 1, to: 2 }), false);
});

test("a clean failure releases at once instead of waiting out the lease", async () => {
  const sql = recordingSql();
  await releaseShard(sql, { chain: "bitcoin", from: 1, to: 2 });
  const stmt = sql.statements[0] ?? "";
  ok(/SET claimed_at = NULL/.test(stmt), "a known failure must return the shard immediately");
  ok(!/DELETE/.test(stmt), "releasing is not retiring -- the work still needs doing");
});

test("enqueueing the same unclaimed range twice does not duplicate it", async () => {
  const sql = recordingSql([]);
  await enqueueShards(sql, [{ chain: "bitcoin", from: 100, to: 200 }]);
  const stmt = sql.statements[0] ?? "";
  ok(/NOT EXISTS/.test(stmt), "a planner running every tick must not pile up duplicates");
  ok(
    /claimed_at IS NULL/.test(stmt),
    "but a CLAIMED row must not suppress re-enqueue: if its lease expires the range really does need doing"
  );
});

test("enqueue reports how many rows it actually created", async () => {
  const none = recordingSql([]);
  eq(await enqueueShards(none, [{ chain: "bitcoin", from: 1, to: 2 }]), 0, "a duplicate adds none");
  const one = recordingSql([{ id: "7" }]);
  eq(await enqueueShards(one, [{ chain: "bitcoin", from: 1, to: 2 }]), 1);
});

test("a zero or negative limit claims nothing and touches the database", async () => {
  const sql = recordingSql();
  eq((await claimShards(sql, "bitcoin", 0)).length, 0);
  eq(sql.statements.length, 0, "an empty claim must not issue a query at all");
});

test("claimed rows come back as shards the walker can use", async () => {
  const sql = recordingSql([
    { id: "1", chain: "bitcoin", from_height: "964000", to_height: "965999", attempts: 1 },
  ]);
  const got = await claimShards(sql, "bitcoin", 1);
  eq(got.length, 1);
  eq(got[0]!.from, 964_000, "heights arrive from pg as strings and must be numbers");
  eq(got[0]!.to, 965_999);
  eq(got[0]!.chain, "bitcoin");
});

test("the planner's output is directly enqueueable", async () => {
  // The two halves must actually fit: a planner whose shards the claimer
  // cannot store is two designs, not one.
  const shards = planShards("bitcoin", 966_081).slice(0, 3);
  const sql = recordingSql([{ id: "1" }]);
  eq(await enqueueShards(sql, shards), 3);
  for (const v of sql.values) {
    eq(v[3], SHARD_REASON, "every row must carry the shard reason");
    ok(Number(v[1]) <= Number(v[2]), "from must never exceed to");
  }
});

test("the lease default is long enough to walk a shard, short enough to recover", () => {
  ok(CLAIM_LEASE_SEC >= 300, "too short and a live worker's shard is stolen mid-walk");
  ok(CLAIM_LEASE_SEC <= 3600, "too long and an abandoned shard blocks the past for an hour+");
});
