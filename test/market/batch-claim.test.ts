import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Batch job claiming -- and an honest account of how much it actually buys.
 *
 * claimDataJob claims exactly ONE job per transaction: BEGIN, a table-wide
 * lease-reaper UPDATE, an index scan under FOR UPDATE SKIP LOCKED, an UPDATE,
 * COMMIT. Correct, fair, starvation-free.
 *
 * I first believed that per-job coordination was the throughput ceiling.
 * IT IS NOT, and the arithmetic below says so plainly: at 120 concurrent slots
 * and ~3 ms per claim, coordination is 0.1%-1% of a job. The ceiling is
 * SLOTS x JOB DURATION, and the dominant duration is waiting on a public
 * gateway for content-addressed bytes that never needed fetching twice.
 *
 * Batching is still worth shipping -- it removes a table-wide UPDATE per job
 * (two writes per unit of work) and halves round trips on the discovery path
 * that claims twice -- but it is a small win, and calling it a large one would
 * have sent the next person optimising the wrong layer.
 *
 * The real danger with batching is that throughput is trivially easy to buy by
 * quietly discarding fairness. Most of these tests exist to stop exactly that.
 */

const CP = readFileSync("lib/market/multichain/control-plane.ts", "utf8").replace(/\r\n/g, "\n");

/** The batch function's body, bounded by the next top-level declaration. */
function batchBody(): string {
  const at = CP.indexOf("export async function claimDataJobs");
  assert.ok(at > 0, "claimDataJobs must exist");
  const end = CP.indexOf("\n/**", at);
  return CP.slice(at, end > at ? end : undefined);
}

test("the batch claim exists and is bounded", () => {
  const body = batchBody();
  // A worker that claims more than it can run holds leases it is not working,
  // and every one is a job no other worker may take until expiry. Throughput,
  // not a licence to hoard.
  assert.match(body, /Math\.min\(Math\.trunc\(count\), 50\)/, "the batch must have a hard ceiling");
  assert.match(body, /Math\.max\(1,/, "and a floor, so a zero never claims nothing forever");
});

test("SKIP LOCKED survives -- workers must never collide or serialise", () => {
  // The property that makes N workers safe against one queue. Without it a
  // batch claim would be far WORSE than single claims: each worker would block
  // on the others' rows for the length of a whole batch.
  assert.match(batchBody(), /FOR UPDATE OF j SKIP LOCKED/, "batching must not drop SKIP LOCKED");
});

test("the fairness ordering is identical to the single claim", () => {
  // Bought with a real starvation incident: CloneX's anchored-membership job
  // sat at max priority with ZERO claims while older, repeatedly-failing jobs
  // won the id tiebreak forever. `attempts ASC` is what makes every job get a
  // real first try before any job gets a second.
  //
  // A batch claim that reordered would reintroduce that bug at 20x the rate.
  const body = batchBody();
  assert.match(
    body,
    /ORDER BY j\.priority DESC, j\.attempts ASC, j\.not_before ASC, j\.id ASC/,
    "the batch must use the same starvation-free ordering"
  );
  // And the single-claim path must still exist unchanged -- this is additive.
  assert.match(CP, /export async function claimDataJob\(/, "the single claim must remain");
});

test("every batched job is leased to this owner", () => {
  // A worker that dies mid-batch must release ALL of them on expiry rather
  // than taking them to the grave. Without a lease per row, a crash would
  // strand every job in the batch.
  const body = batchBody();
  assert.match(body, /lease_owner = \$\{ownerParam\}/, "each row must carry the owner");
  assert.match(body, /lease_expires_at = NOW\(\) \+ /, "and an expiry");
  assert.match(body, /leaseOwner: owner/, "returned so the caller can finish or defer it");
});

test("the lease reaper runs once per batch, not once per job", () => {
  // It is a table-wide UPDATE. Paying it per job was pure overhead -- two
  // writes for every unit of work.
  const body = batchBody();
  const reaps = (body.match(/status = 'queued', lease_owner = NULL/g) ?? []).length;
  assert.equal(reaps, 1, `the reaper must run once per batch, saw ${reaps}`);
  // It must still run: an expired lease that is never reclaimed is a job lost
  // forever, which is worse than the overhead it costs.
  assert.match(body, /lease_expires_at < NOW\(\)/, "expired leases must still be reclaimed");
});

test("a failure rolls the whole batch back", () => {
  // Partial commit would leave rows marked running with no worker -- claimed
  // by nobody, released only by lease expiry, invisible until then.
  const body = batchBody();
  assert.match(body, /await client\.query\("BEGIN"\)/, "one transaction");
  assert.match(body, /await client\.query\("COMMIT"\)/, "one commit");
  assert.match(body, /await client\.query\("ROLLBACK"\)/, "and a rollback on any error");
  assert.match(body, /client\.release\(\)/, "the connection must always return to the pool");
});

/**
 * THE THROUGHPUT MODEL, AND A CORRECTION TO MY OWN CLAIM.
 *
 * I first argued that per-job claim transactions were the ceiling. Working the
 * arithmetic out properly says otherwise, and the correction is worth more
 * than the original claim:
 *
 *   12 workers x 10 slots = 120 concurrent slots
 *   claim cost ~3 ms; job duration 0.3-10 s
 *   => coordination is 0.1%-1% of a job. It is NOT the ceiling.
 *
 * The real ceiling is SLOTS x JOB DURATION:
 *
 *   job = 0.3 s  ->  1,440,000 jobs/h  ->  a 1.7M-job sweep in  1.2 h
 *   job = 1.0 s  ->    432,000 jobs/h  ->                        4.0 h
 *   job = 3.0 s  ->    144,000 jobs/h  ->                       12.0 h
 *   job = 10  s  ->     43,200 jobs/h  ->                       39.9 h
 *
 * So the lever that matters is JOB DURATION, not claim count -- and the
 * largest single component of duration is waiting on a public gateway for
 * bytes that are content-addressed and therefore never need fetching twice.
 * That is what the proof cache attacks, and why it, not batching, is the
 * throughput story.
 *
 * Batching is still worth having: it removes a table-wide lease-reaper UPDATE
 * per job (two writes per unit of work) and halves the round trips on the
 * discovery path that claims twice. But it is a 1% optimisation wearing a 20x
 * costume, and saying so is more useful than shipping it under a false claim.
 */
function jobsPerHour(slots: number, jobSeconds: number): number {
  return slots * (3600 / jobSeconds);
}

test("the ceiling is slots x job duration, not claim count", () => {
  const slots = 120;
  // A tenfold change in job duration is a tenfold change in throughput.
  assert.equal(jobsPerHour(slots, 1) / jobsPerHour(slots, 10), 10);
  // Whereas claim overhead is noise against any realistic job.
  const claimMs = 3;
  for (const jobSec of [0.3, 1, 3]) {
    const overhead = claimMs / 1000 / jobSec;
    assert.ok(overhead < 0.02, `claim overhead must be <2% of a job (saw ${(overhead * 100).toFixed(1)}%)`);
  }
});

test("a full sweep is bounded by duration, and the numbers say which fixes matter", () => {
  const sweep = 345_000 * 5; // ~1.7M facet-jobs
  const slots = 120;
  const fast = sweep / jobsPerHour(slots, 0.3);
  const slow = sweep / jobsPerHour(slots, 10);
  assert.ok(fast < 2, `a cached, fast job finishes a sweep in about an hour (saw ${fast.toFixed(1)}h)`);
  assert.ok(slow > 24, `a gateway-bound job makes it multi-day (saw ${slow.toFixed(1)}h)`);
  // Which is the whole argument for the proof cache over more workers.
  assert.ok(slow / fast > 20, "duration dominates by more than an order of magnitude");
});
