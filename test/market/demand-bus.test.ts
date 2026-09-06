import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresQuery } from "../../lib/postgres";
import { computeIntentPriority, INTENT_BASE_PRIORITY, INTENT_MAX_PRIORITY, clientHash, publishIntent } from "../../lib/market/multichain/edge/demand-bus";
import { DEMAND_PRIORITY } from "../../lib/market/multichain/collection-demand";

/** priority = f(users watching, money at stake, staleness, cost to refresh) -- pure and explainable. */

test("base priorities are ordered by how much a human has committed: read < hover < search < facet < viewport < wallet < click < sweep", () => {
  const b = INTENT_BASE_PRIORITY;
  assert.ok(b.read < b.hover && b.hover < b.search && b.search < b.facet && b.facet < b.viewport && b.viewport < b["wallet-connect"] && b["wallet-connect"] < b.click && b.click < b.sweep);
  assert.equal(b.viewport, DEMAND_PRIORITY.VISIBLE, "viewport tier must match the visibility route's own base");
});

test("more watchers raise priority with diminishing returns, capped at +8", () => {
  const base = { kind: "hover" as const, moneyAtStakeUsd: 0, stalenessMs: 0, refreshCostUnits: 0 };
  const p1 = computeIntentPriority({ ...base, watchers: 1 });
  const p3 = computeIntentPriority({ ...base, watchers: 3 });
  const p15 = computeIntentPriority({ ...base, watchers: 15 });
  const p1000 = computeIntentPriority({ ...base, watchers: 1000 });
  assert.ok(p1 < p3 && p3 < p15, `${p1} ${p3} ${p15}`);
  assert.equal(p1000 - INTENT_BASE_PRIORITY.hover, 8);
});

test("money at stake raises priority on a log10 scale, capped at +10", () => {
  const base = { kind: "sweep" as const, watchers: 0, stalenessMs: 0, refreshCostUnits: 0 };
  const p0 = computeIntentPriority({ ...base, moneyAtStakeUsd: 0 });
  const p10 = computeIntentPriority({ ...base, moneyAtStakeUsd: 10 });
  const p1k = computeIntentPriority({ ...base, moneyAtStakeUsd: 1_000 });
  const p1m = computeIntentPriority({ ...base, moneyAtStakeUsd: 1_000_000 });
  assert.equal(p10 - p0, 2);
  assert.equal(p1k - p0, 6);
  assert.equal(p1m, INTENT_MAX_PRIORITY, "hard ceiling so nothing pins the queue forever");
});

test("staleness raises and refresh cost lowers priority; never-hydrated counts as maximally stale", () => {
  const base = { kind: "click" as const, watchers: 1, moneyAtStakeUsd: 0 };
  const fresh = computeIntentPriority({ ...base, stalenessMs: 0, refreshCostUnits: 0 });
  const stale = computeIntentPriority({ ...base, stalenessMs: 30 * 60_000, refreshCostUnits: 0 });
  const never = computeIntentPriority({ ...base, stalenessMs: null, refreshCostUnits: 0 });
  const expensive = computeIntentPriority({ ...base, stalenessMs: 0, refreshCostUnits: 300 });
  assert.equal(stale - fresh, 3);
  assert.equal(never - fresh, 6);
  assert.equal(fresh - expensive, 6);
});

test("unknown keys are pinned to the UNKNOWN_KEY tier regardless of money or watchers (junk cannot skip the line)", () => {
  const p = computeIntentPriority({ kind: "sweep", watchers: 500, moneyAtStakeUsd: 1e9, stalenessMs: null, refreshCostUnits: 0, unknownKey: true });
  assert.equal(p, DEMAND_PRIORITY.UNKNOWN_KEY);
});

test("a sweep with real money outranks an aged viewport, but stays bounded", () => {
  const sweep = computeIntentPriority({ kind: "sweep", watchers: 1, moneyAtStakeUsd: 500, stalenessMs: 0, refreshCostUnits: 100 });
  assert.ok(sweep > DEMAND_PRIORITY.VISIBLE_STALE_AGED);
  assert.ok(sweep <= INTENT_MAX_PRIORITY);
});

test("clientHash is stable, salted and never the raw ip", () => {
  const a = clientHash("203.0.113.9", "ua");
  assert.equal(a, clientHash("203.0.113.9", "ua"));
  assert.notEqual(a, clientHash("203.0.113.10", "ua"));
  assert.ok(!a.includes("203.0.113"));
  assert.equal(a.length, 24);
});

test(
  "publishIntent: unknown subjects are recorded but enqueue nothing; distinct clients are counted as watchers",
  { skip: !hasPostgresConfig() },
  async () => {
    const chainSlug = "zztest-chain";
    const subject = `zz-${Date.now()}`;
    try {
      const r1 = await publishIntent({ kind: "hover", chainSlug, subjects: [subject] }, { hash: "client-a" });
      assert.equal(r1.accepted, 1);
      assert.equal(r1.enqueued, 0, "an untracked key must never enqueue real work");
      assert.equal(r1.decisions[0].known, false);
      assert.equal(r1.decisions[0].priority, DEMAND_PRIORITY.UNKNOWN_KEY);
      await publishIntent({ kind: "hover", chainSlug, subjects: [subject] }, { hash: "client-b" });
      const r3 = await publishIntent({ kind: "hover", chainSlug, subjects: [subject] }, { hash: "client-c" });
      assert.equal(r3.decisions[0].watchers, 3, "three distinct clients (including this one) are watching");
      const rows = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text n FROM plank_demand_intents WHERE chain_slug = $1 AND subject = $2`, [chainSlug, subject]);
      assert.equal(rows.rows[0].n, "3");
      const jobs = await postgresQuery<{ n: string }>(`SELECT COUNT(*)::text n FROM plank_data_jobs WHERE chain_slug = $1 AND subject = $2`, [chainSlug, subject]);
      assert.equal(jobs.rows[0].n, "0");
    } finally {
      await postgresQuery(`DELETE FROM plank_demand_intents WHERE chain_slug = $1`, [chainSlug]);
    }
  }
);
