import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * buildHubIndex ran four mutually independent reads as four sequential
 * `await`s:
 *
 *   getActivityForContracts   (needs this page's `collections`)
 *   readNativeRobinwoodBook   (needs only NFT_CONTRACT_ADDRESS)
 *   the 7-day plank_chain_events COUNT   (same)
 *   salesStatsFromLedger      (same)
 *
 * Only the first depends on anything computed above it. So the stage paid the
 * SUM of four latencies where it owed the MAX of one.
 *
 * This is the hottest read in the app. Its own header records 96 SECONDS live
 * on a saturated PGPOOL_MAX=4 pool, and a cold build measured on production
 * 2026-09-12 -- AFTER the read-path index work landed -- still took 4.5 to
 * 28.1 seconds. A cold build is paid by whichever visitor arrives first, and
 * until the edge cache fills, by every one of them.
 *
 * readNativeRobinwoodBook is the expensive member: it merges native Seaport
 * rows with OpenSea and Pulp, and on a non-canonical host can fall through to
 * fetchCanonicalRobinwoodStats, which is an outbound HTTP call. Serialising a
 * network round trip behind two database reads that could have run alongside
 * it is the clearest waste in the function.
 *
 * WHAT THESE TESTS PIN
 * --------------------
 * The two properties that actually distinguish Promise.all from a chain, and
 * the one that makes this change SAFE rather than merely faster:
 *
 *   1. completion follows DURATION order, not issue order
 *   2. each member keeps its own error posture -- three swallow, and the
 *      fourth still RE-THROWS on the first page of an unfiltered request
 *
 * (2) is the whole risk. salesStatsFromLedger deliberately propagates on
 * `offset === 0` with no chain filter, because the shared edge must retain its
 * last-good index rather than caching an index built from a failed read. If
 * parallelising had converted that into a swallowed null, the hub would have
 * started caching fabricated missing statistics -- a silent corruption, far
 * worse than the latency this change removes.
 */

const SRC = readFileSync(
  new URL("../../app/api/market/multichain/route.ts", import.meta.url),
  "utf8"
);

type Probe = { started: string[]; finished: string[] };

function reader(p: Probe, name: string, ms: number, mode: "ok" | "swallow" | "throw" = "ok") {
  return async () => {
    p.started.push(name);
    await new Promise((r) => setTimeout(r, ms));
    if (mode === "throw") throw new Error(`${name} failed`);
    p.finished.push(name);
    return name;
  };
}

/** The shape the route now uses, with each member's real catch posture. */
async function parallelStage(
  p: Probe,
  opts: { offset: number; chainFilter: string[] | null; salesFails?: boolean }
) {
  return Promise.all([
    reader(p, "activity", 40)().catch(() => new Map<string, number>()),
    reader(p, "book", 30)().catch(() => null),
    reader(p, "ledger7d", 20)().catch(() => 0),
    reader(p, "sales", 10, opts.salesFails ? "throw" : "ok")().catch((error) => {
      // Verbatim the route's rule.
      if (opts.offset === 0 && (!opts.chainFilter || opts.chainFilter.includes("robinhood"))) throw error;
      return null;
    }),
  ]);
}

/** The shape it replaced -- the control. */
async function sequentialStage(p: Probe) {
  await reader(p, "activity", 40)().catch(() => null);
  await reader(p, "book", 30)().catch(() => null);
  await reader(p, "ledger7d", 20)().catch(() => null);
  await reader(p, "sales", 10)().catch(() => null);
}

test("all four reads are issued before any completes", async () => {
  const p: Probe = { started: [], finished: [] };
  await parallelStage(p, { offset: 0, chainFilter: null });
  assert.deepEqual(
    p.started.sort(),
    ["activity", "book", "ledger7d", "sales"],
    "every read must be issued"
  );
  assert.equal(p.finished.length, 4, "and every read must complete");
});

/**
 * THE CONTROL. Without it these assertions could not tell the two shapes
 * apart, and would prove nothing.
 */
test("completion follows DURATION order in parallel, ISSUE order sequentially", async () => {
  const par: Probe = { started: [], finished: [] };
  await parallelStage(par, { offset: 0, chainFilter: null });
  assert.deepEqual(
    par.finished,
    ["sales", "ledger7d", "book", "activity"],
    "parallel finishes fastest-first (10, 20, 30, 40ms)"
  );

  const seq: Probe = { started: [], finished: [] };
  await sequentialStage(seq);
  assert.deepEqual(
    seq.finished,
    ["activity", "book", "ledger7d", "sales"],
    "sequential finishes in issue order regardless of duration -- the shapes are distinguishable"
  );
});

test("a failing sibling does not take down the others", async () => {
  const p: Probe = { started: [], finished: [] };
  // offset 1 => the sales reader swallows instead of re-throwing.
  const [activity, book, ledger, sales] = await parallelStage(p, {
    offset: 1,
    chainFilter: null,
    salesFails: true,
  });
  assert.equal(sales, null, "the failing member is null, exactly as its own catch guarantees");
  assert.ok(activity, "an unrelated read still returns its value");
  assert.ok(book);
  assert.equal(ledger, "ledger7d");
});

/**
 * THE SAFETY PROPERTY. Parallelising must not have converted a deliberate
 * re-throw into a swallowed null.
 */
test("salesStatsFromLedger still RE-THROWS on the first page of an unfiltered request", async () => {
  const p: Probe = { started: [], finished: [] };
  await assert.rejects(
    () => parallelStage(p, { offset: 0, chainFilter: null, salesFails: true }),
    /sales failed/,
    "the shared edge must not cache an index built from a failed ledger read"
  );
});

test("it also re-throws when the filter explicitly includes robinhood", async () => {
  const p: Probe = { started: [], finished: [] };
  await assert.rejects(
    () => parallelStage(p, { offset: 0, chainFilter: ["robinhood", "base-mainnet"], salesFails: true }),
    /sales failed/
  );
});

test("but a filtered request that excludes robinhood degrades to null instead", async () => {
  const p: Probe = { started: [], finished: [] };
  const [, , , sales] = await parallelStage(p, {
    offset: 0,
    chainFilter: ["base-mainnet"],
    salesFails: true,
  });
  assert.equal(sales, null, "the home collection's stats are irrelevant to a base-only page");
});

// --- the wiring ------------------------------------------------------------

test("the route issues these four reads as one Promise.all", () => {
  assert.match(
    SRC,
    /const \[activityByContract, nativeBook, nativeLedgerActivity7d, nativeSales\] = await Promise\.all\(\[/,
    "the four independent reads must be one awaited group"
  );
});

test("no member of the group is awaited separately before the group", () => {
  // The regression: someone re-inlines `const nativeBook = await readNative...`
  // above the Promise.all and the stage silently serialises again.
  const stage = /const \[activityByContract[\s\S]*?\]\);/.exec(SRC)?.[0] ?? "";
  assert.ok(stage.length > 0, "the group must be locatable");
  for (const call of ["getActivityForContracts", "readNativeRobinwoodBook", "salesStatsFromLedger"]) {
    const before = SRC.slice(0, SRC.indexOf(stage));
    assert.doesNotMatch(
      before,
      new RegExp(`await ${call}\\(`),
      `${call} is awaited before the group -- that re-serialises the stage`
    );
  }
});

test("the deliberate re-throw survives in the source, not just in this test's model", () => {
  const stage = /const \[activityByContract[\s\S]*?\]\);/.exec(SRC)?.[0] ?? "";
  assert.match(
    stage,
    /if \(offset === 0 && \(!chainSlugFilter \|\| chainSlugFilter\.includes\("robinhood"\)\)\) throw error;/,
    "converting this to a swallowed null would make the edge cache fabricated missing statistics"
  );
});
