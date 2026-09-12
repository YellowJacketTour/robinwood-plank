import assert from "node:assert/strict";
import test from "node:test";
import { hasPostgresConfig, postgresPool, postgresQuery } from "../../lib/postgres";

/**
 * getArchivalStatsForCollection issued THREE SEQUENTIAL BATCHES of reads that
 * all took the same two inputs.
 *
 * It used to await in three stages:
 *
 *     1. Promise.all([stats, jobProcessing, projected_count, max(token_id)])
 *     2. await getCollectionSupplyStats(...)            -- the mall ratchet
 *     3. Promise.all([metadata COUNT(*), coverage counters])
 *
 * Every query in all three stages takes exactly (chainSlug, normalized).
 * Stage 2 reads nothing stage 1 returned; stage 3 reads nothing stage 1 or 2
 * returned. Only the JavaScript after them combines the values. The staging
 * was an artifact of the order the statements happened to be written in.
 *
 * That cost three sequential round trips to Postgres where one would do, on a
 * pool capped at PGPOOL_MAX=4, on the route behind every collection page.
 * Production, plank.love 2026-09-12, CryptoPunks:
 * /api/market/multichain/collection took 17.7s cold, 6.6s warm, while
 * /api/market/multichain/listings on the same page took 0.2s.
 *
 * WHAT THIS TEST ASSERTS, AND WHY IT IS NOT A MIRROR
 * --------------------------------------------------
 * It does not re-implement the batching and check its own arithmetic, and it
 * does not assert a duration (a wall-clock assertion in this repo once passed
 * while a walk took 5,000,003 steps).
 *
 * It calls the REAL getArchivalStatsForCollection against a REAL Postgres and
 * observes, through the pool that the real code actually uses, how many of its
 * queries were in flight at the same moment. Concurrency is the property being
 * fixed, so concurrency is what is measured -- and it is measured as a fact
 * about the code's behaviour, not restated from the code's shape.
 *
 * THE BAR IS "EVERY READ OVERLAPPED", NOT "MORE THAN THE OLD CODE MANAGED".
 *
 * The first version of this test asserted peak > 4, on the reasoning that the
 * old three-stage code (4, then 1, then 2) could never exceed 4. That bar was
 * real but far too loose, and MUTATION TESTING CAUGHT IT: pulling a single
 * query back out of the batch into its own sequential await still left a peak
 * of 6, and the test passed. It detected total collapse and nothing short of
 * it -- so it would have sat green through a partial re-serialization, which
 * is by far the likelier regression.
 *
 * It now asserts peak === total: every read this function issues was in flight
 * simultaneously. That is the actual property, stated exactly. Moving ANY
 * single read back out of the batch drops peak below total and fails, which is
 * what the corrected mutation test confirms.
 *
 * Note this is measured, not assumed: `total` is counted from the real calls
 * rather than hard-coded, so adding a legitimate new read to the batch keeps
 * the test passing while moving one out of it does not.
 */

const SKIP = { skip: !hasPostgresConfig() };

/**
 * Wraps the live pool's query method to record the peak number of overlapping
 * calls, then restores it. This observes the same pool object postgresQuery
 * resolves, so it sees the real function's real traffic.
 */
async function peakConcurrentQueries(run: () => Promise<unknown>): Promise<{ peak: number; total: number }> {
  const pool = postgresPool() as unknown as { query: (...args: unknown[]) => Promise<unknown> };
  const original = pool.query.bind(pool);
  let inFlight = 0;
  let peak = 0;
  let total = 0;
  pool.query = (...args: unknown[]) => {
    inFlight += 1;
    total += 1;
    if (inFlight > peak) peak = inFlight;
    const settle = () => {
      inFlight -= 1;
    };
    return original(...args).then(
      (value) => {
        settle();
        return value;
      },
      (error) => {
        settle();
        throw error;
      }
    );
  };
  try {
    await run();
  } finally {
    pool.query = original;
  }
  return { peak, total };
}

test(
  "getArchivalStatsForCollection issues its reads as one parallel batch, not three serial stages",
  SKIP,
  async () => {
    const { getArchivalStatsForCollection } = await import("../../lib/market/multichain/archival-ledger");

    // A real ledger row is required: the function returns null early when
    // there is none, and an early return would make the reads it skips
    // unobservable. Seed one against a collection key no real data uses.
    const chainSlug = "eth-mainnet";
    const collectionKey = "0x00000000000000000000000000000c0ncurrency".slice(0, 42);
    await postgresQuery(
      `INSERT INTO collection_archival_stats
         (chain_slug, collection_key, known_supply, tokens_ever_hydrated, archival_score, score_method, last_archived_at)
       VALUES ($1, $2, 10000, 1204, 0.1204, 'supply_ratio', NOW())
       ON CONFLICT (chain_slug, collection_key) DO UPDATE
         SET tokens_ever_hydrated = EXCLUDED.tokens_ever_hydrated`,
      [chainSlug, collectionKey]
    );

    const { peak, total } = await peakConcurrentQueries(() =>
      getArchivalStatsForCollection(chainSlug, collectionKey)
    );

    assert.ok(
      total >= 5,
      `expected the function to issue its full set of reads, saw only ${total}. If the ledger ` +
        `row was not found it returns null early and this measures nothing.`
    );
    assert.equal(
      peak,
      total,
      `peak concurrency was ${peak} of ${total} queries issued. Every read in this function takes ` +
        `only (chainSlug, collectionKey), so all of them can and must be in flight at once. ` +
        `peak < total means ${total - peak} read(s) are being awaited in a separate sequential ` +
        `stage -- which is exactly the shape that made /api/market/multichain/collection take ` +
        `17.7s cold and 6.6s warm in production while /listings on the same page took 0.2s.`
    );
  }
);

/**
 * The same fault one level up: the ROUTE awaited its most expensive read last.
 *
 * getArchivalStatsForCollection's only inputs are chainSlug and collectionSlug,
 * both of which the handler has in its first few lines. It was nonetheless
 * called at the very bottom, after the snapshot reads, the CryptoPunks branch,
 * the Magic Eden branch and the trait-index branch had each finished -- purely
 * because that is where the statement sat in the file. The route's wall time
 * was archival + everything else instead of max(archival, everything else).
 *
 * WHY THIS ONE IS A SOURCE CHECK, SAID PLAINLY
 * --------------------------------------------
 * The honest way to assert this is the way the test above does it: drive the
 * real handler and watch the real pool. That was written first and DOES NOT
 * WORK here, for a specific and verified reason -- this route calls Next's
 * `after()`, which throws "`after` was called outside a request scope" when
 * the handler is invoked directly from a test, so the handler returns 500
 * before issuing any of the reads in question. Verified by running it: the
 * behavioural version failed with "the route never read
 * collection_archival_stats", which is the guard doing its job, not the
 * property being false.
 *
 * So this asserts the weaker structural fact instead, and says so rather than
 * dressing it up: the call that STARTS the archival read appears before the
 * `await` on the snapshot batch, and the only `await` on its result comes
 * later. That is genuinely weaker than an observed overlap -- it reads the
 * source rather than the behaviour. It is kept because it still fails on the
 * exact regression it guards (moving the call back down to its old position),
 * and because a stated-weak check beats no check; the batching that does the
 * larger share of the work is covered behaviourally by the test above.
 */
test(
  "the collection route starts its archival read before awaiting the snapshot batch",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const path = new URL("../../app/api/market/multichain/collection/route.ts", import.meta.url);
    const src = await readFile(path, "utf8");

    const startIdx = src.indexOf("getArchivalStatsForCollection(chainSlug, collectionSlug)");
    const snapshotAwaitIdx = src.indexOf("await Promise.all([");
    const resultAwaitIdx = src.indexOf("await archivalPromise");

    assert.ok(startIdx > 0, "the route no longer calls getArchivalStatsForCollection at all");
    assert.ok(snapshotAwaitIdx > 0, "the route no longer awaits a Promise.all of its snapshot reads");
    assert.ok(
      resultAwaitIdx > 0,
      "the archival result is no longer awaited via a hoisted promise. If this call was moved " +
        "back to a plain `await getArchivalStatsForCollection(...)` at the bottom of the handler, " +
        "the route is serial again: its wall time becomes archival + everything else instead of " +
        "max(archival, everything else)."
    );
    assert.ok(
      startIdx < snapshotAwaitIdx,
      `the archival read is started at offset ${startIdx}, AFTER the snapshot batch is awaited at ` +
        `${snapshotAwaitIdx}. It must be started before, so the two overlap.`
    );
    assert.ok(
      resultAwaitIdx > snapshotAwaitIdx,
      "the archival promise is awaited before the snapshot batch, which serialises it again just " +
        "as thoroughly as calling it last did."
    );
  }
);
