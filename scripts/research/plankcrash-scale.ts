import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { settleCappedPool } from "../../lib/casino/economics-capped-pool.js";

// Economic aggregation only. No claim of executing N on-chain transactions.
// Each class contains count IDENTICAL positions. Floors and caps are computed
// per position before multiplication, so aggregation preserves integer rules.
type Group = { stake: bigint; target: bigint; count: bigint };
let checks = 0;
function check(ok: boolean) { checks++; assert.ok(ok); }
function clear(groups: Group[], budget: bigint, crash: bigint) {
  const pay = groups.map(g => g.target <= crash ? g.stake * 7500n / 10000n : 0n);
  const active = groups.map((g, i) => ({ g, i, room: g.stake * g.target / 10000n - pay[i] })).filter(x => x.g.target <= crash);
  active.sort((a, b) => a.room * b.g.stake < b.room * a.g.stake ? -1 : a.room * b.g.stake > b.room * a.g.stake ? 1 : 0);
  let remaining = budget - pay.reduce((sum, p, i) => sum + p * groups[i].count, 0n);
  let weight = active.reduce((sum, x) => sum + x.g.stake * x.g.count, 0n);
  check(remaining >= 0n);
  while (active.length && active[0].room * weight <= remaining * active[0].g.stake) {
    const x = active.shift()!; pay[x.i] += x.room;
    remaining -= x.room * x.g.count; weight -= x.g.stake * x.g.count;
  }
  for (const x of active) pay[x.i] += remaining * x.g.stake / weight;
  const paid = pay.reduce((sum, p, i) => sum + p * groups[i].count, 0n);
  check(paid <= budget);
  groups.forEach((g, i) => {
    check(pay[i] <= g.stake * g.target / 10000n);
    check(g.target > crash ? pay[i] === 0n : pay[i] >= g.stake * 7500n / 10000n);
  });
  return { pay, paid, returned: budget - paid };
}
const targets = [10100n, 10200n, 15000n, 20000n, 100000n, 1000000n, 10000000n, 100000000n];
function population(n: bigint, skew: number): Group[] {
  const count = n < 64n ? Number(n) : 64;
  return Array.from({ length: count }, (_, i) => ({
    count: n / BigInt(count) + (BigInt(i) < n % BigInt(count) ? 1n : 0n),
    stake: 10001n * 10n ** BigInt(skew ? i % 8 : 0), target: targets[(i + skew) % targets.length],
  }));
}

// Verify grouped arithmetic against individual payouts before scaling counts.
for (let n = 1; n <= 256; n += 17) {
  const groups = population(BigInt(n), 1);
  const seats = groups.flatMap(g => Array.from({ length: Number(g.count) }, () => ({ id: "", stake: g.stake, targetBps: g.target }))).map((s, i) => ({ ...s, id: String(i) }));
  const q = seats.reduce((sum, s) => sum + s.stake, 0n), d = q * 9550n / 10000n;
  for (const crash of targets) {
    const grouped = clear(groups, d + q, crash);
    const individual = settleCappedPool(d, q, crash, seats);
    const expanded = groups.flatMap((g, i) => Array(Number(g.count)).fill(grouped.pay[i]));
    assert.deepEqual(individual.allocations.map(a => a.payout), expanded); checks++;
  }
}

const rows: object[] = [];
for (const n of [1n, 1000n, 1000000n, 1000000000n]) {
  for (let skew = 0; skew < 8; skew++) {
    const groups = population(n, skew), q = groups.reduce((sum, g) => sum + g.stake * g.count, 0n);
    const d = q * 9550n / 10000n;
    for (const crash of [10000n, ...targets]) for (const h of [0n, q, q * 10000n]) {
      const r = clear(groups, d + h, crash);
      check(r.paid + r.returned === d + h);
      rows.push({ population: n.toString(), skew, crash: crash.toString(), funding: h.toString(), paid: r.paid.toString() });
    }
  }
}

// Worst-outcome rolling solvency: a billion synthetic positions per book,
// alternating all-survive, all-bust and mixed outcomes chosen adversarially.
// Only the spendable buffer may underwrite. Rake stays separate; the chosen
// small protected increment is a model assumption, not the router's full split.
let free = 10n ** 25n, protectedFunds = 10n ** 24n, fees = 0n, paidTotal = 0n, inflow = free + protectedFunds;
for (let i = 0; i < 10000; i++) {
  const groups = population(1000000000n, i % 8), q = groups.reduce((sum, g) => sum + g.stake * g.count, 0n);
  const d = q * 9550n / 10000n, rake = q - d, h = free / 10n;
  const r = clear(groups, d + h, i % 3 === 0 ? 100000000n : i % 3 === 1 ? 10000n : targets[i % 8]);
  const increment = rake / 10n, priorProtected = protectedFunds;
  free = free - h + r.returned; protectedFunds += increment; fees += rake - increment;
  paidTotal += r.paid; inflow += q;
  check(free >= 0n && protectedFunds >= priorProtected);
  check(free + protectedFunds + fees + paidTotal === inflow);
}
const report = { schema: "plankcrash.capped-scale.v1", checks, staticBooks: rows.length,
  largestPopulation: "1000000000", repeatedBooks: 10000, individualCrossChecks: "1..256 positions",
  claim: "Caps, funded floors, conservation and protected-fund isolation in aggregated economic models",
  limits: "NOT billion-user throughput, not a rollup implementation, not a randomness or liveness proof. Current on-chain round cap remains 256 positions. Repeated-book fee partition is an explicit model assumption.",
  free: free.toString(), protectedFunds: protectedFunds.toString(), cases: rows };
const path = process.argv[2]; if (path) writeFileSync(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, cases: undefined }));
