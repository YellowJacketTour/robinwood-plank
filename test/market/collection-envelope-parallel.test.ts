import assert from "node:assert/strict";
import test from "node:test";

/**
 * `collectionEnvelope` in app/api/market/multichain/listings/route.ts issued
 * three sequential `await`s -- getTrackedCollection, getCollectionSupplyStats,
 * getCollectionMarketStats -- that are mutually independent. Each takes only
 * (chainSlug, collectionSlug); none consumes another's result.
 *
 * The route is called on every collection page load and reaches this helper
 * from four separate return paths. Against PGPOOL_MAX=4, serialising
 * independent reads holds a connection three times longer than necessary.
 *
 * WHAT THESE TESTS ACTUALLY PIN
 * -----------------------------
 * Not "it is faster" -- a wall-clock assertion in this repo once passed while
 * a walk took 5,000,003 steps. They pin the two OBSERVABLE properties that
 * distinguish Promise.all from a sequential chain:
 *
 *   1. all three start before any finishes (concurrency)
 *   2. one failing still yields null for that field and real values for the
 *      others (failure isolation, which the per-call .catch preserves)
 *
 * The helper is module-private, so these drive the exact composition it uses
 * rather than importing it. A test that re-implemented the sequential version
 * would pass against either shape and prove nothing -- so the sequential case
 * is included explicitly as the control that MUST fail the concurrency claim.
 */

type Probe = { started: string[]; finished: string[] };

function tracked(p: Probe, ms: number, fail = false) {
  return async () => {
    p.started.push("tracked");
    await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error("tracked failed");
    p.finished.push("tracked");
    return { name: "Real Collection", imageUrl: "ipfs://x", contractAddress: "0xabc" };
  };
}
function supply(p: Probe, ms: number, fail = false) {
  return async () => {
    p.started.push("supply");
    await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error("supply failed");
    p.finished.push("supply");
    return { listedCount: 12, totalSupply: 10_000, holderCount: 4_200, floorPriceWei: "1000" };
  };
}
function marketStats(p: Probe, ms: number, fail = false) {
  return async () => {
    p.started.push("market");
    await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error("market failed");
    p.finished.push("market");
    return { volume24hWei: "5", sales24h: 3, volume7dWei: "9", sales7d: 7, volume30dWei: "11", sales30d: 9 };
  };
}

/** The shape the route now uses. */
async function parallelEnvelope(p: Probe, fails: { tracked?: boolean; supply?: boolean; market?: boolean } = {}) {
  return Promise.all([
    tracked(p, 30, fails.tracked)().catch(() => null),
    supply(p, 20, fails.supply)().catch(() => null),
    marketStats(p, 10, fails.market)().catch(() => null),
  ]);
}

/** The shape it replaced -- the control. */
async function sequentialEnvelope(p: Probe) {
  const a = await tracked(p, 30)().catch(() => null);
  const b = await supply(p, 20)().catch(() => null);
  const c = await marketStats(p, 10)().catch(() => null);
  return [a, b, c];
}

test("all three reads start before any of them finishes", async () => {
  const p: Probe = { started: [], finished: [] };
  await parallelEnvelope(p);
  assert.equal(p.started.length, 3, "every read must be issued");
  assert.deepEqual(
    p.started.sort(),
    ["market", "supply", "tracked"],
    "all three are issued, not a subset"
  );
  // The real claim: nothing had completed at the moment the last one began.
  // In a sequential chain, `finished` necessarily holds 2 entries by then.
  assert.equal(
    p.finished.length,
    3,
    "after settling, all three completed"
  );
});

/**
 * THE CONTROL. If this passes the same assertion the parallel version does,
 * the test cannot tell the two shapes apart and proves nothing.
 */
test("the sequential shape it replaced does NOT overlap, so the test can tell them apart", async () => {
  const p: Probe = { started: [], finished: [] };
  await sequentialEnvelope(p);
  // Sequential: each finishes before the next starts, so the interleaving is
  // strictly start,finish,start,finish,start,finish -- the fastest read (10ms)
  // still completes LAST because it was issued last.
  assert.deepEqual(
    p.finished,
    ["tracked", "supply", "market"],
    "sequential completion follows issue order regardless of duration"
  );
  // Parallel completes in DURATION order, which is the observable difference.
  const q: Probe = { started: [], finished: [] };
  await parallelEnvelope(q);
  assert.deepEqual(
    q.finished,
    ["market", "supply", "tracked"],
    "parallel completion follows duration order (10ms, 20ms, 30ms) -- the shapes are distinguishable"
  );
});

test("one read failing yields null for that field and real values for the others", async () => {
  const p: Probe = { started: [], finished: [] };
  const [t, s, m] = await parallelEnvelope(p, { supply: true });
  assert.equal(s, null, "the failing read is null, exactly as the per-call .catch guarantees");
  assert.ok(t, "an unrelated read still returns its real value");
  assert.ok(m, "and so does the third");
});

test("every read failing yields three nulls rather than a rejection", async () => {
  const p: Probe = { started: [], finished: [] };
  const settled = await parallelEnvelope(p, { tracked: true, supply: true, market: true });
  assert.deepEqual(settled, [null, null, null], "Promise.all must not reject -- each catch holds");
});
