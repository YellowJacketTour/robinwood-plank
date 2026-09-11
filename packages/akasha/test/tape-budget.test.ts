/**
 * The tape's size budget.
 *
 * `finalized_head` is governed by physics -- blocks arrive at the rate the
 * chain produces them. `backfill_tail` is not: it walks LEFTWARD as fast as
 * the host can drink, across eleven chains, and until this change nothing in
 * this package or in 112 migrations ever told it to stop. A grep of every
 * migration for DELETE/retention/prune/TTL finds exactly one prune in the
 * whole schema (plank_prune_floor_observations, migration 108) and it does
 * not cover akasha_*.
 *
 * The failure is not a slow query. It is a full disk on a shared cPanel host,
 * which takes the web role and the mesh down with it.
 *
 * WHY THESE TESTS ASSERT A REFUSAL AND ITS REASON
 * ----------------------------------------------
 * A backfill that stops silently is indistinguishable from one that finished,
 * and those are opposite facts -- "the past is closed" versus "the past is
 * paused". So it is not enough that the walk halts: it must SAY why, and the
 * reason must not read like completion. That is what is pinned here.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import { PostgresArchiveStore, type SqlClient } from "../src/hose/pg-store.ts";
import { BackfillWorker, DEFAULT_TAPE_BUDGET_BYTES } from "../src/hose/backfill.ts";
import { protocolT0 } from "../src/shared/protocol-t0.ts";
import type { ChainId, Header } from "../src/shared/types.ts";

const hx = (s: string) => s as `0x${string}`;
const noopSql: SqlClient = { async query() { return { rows: [] }; } };

function storeAt(chain: ChainId, origin: number, finalized: number): PostgresArchiveStore {
  const s = new PostgresArchiveStore(noopSql);
  s.putCursor({
    chain,
    t0Hash: hx("0xaa"),
    t0Height: origin,
    tipHash: hx("0xbb"),
    tipHeight: finalized + 3,
    finalizedHash: hx("0xcc"),
    finalizedHeight: finalized,
    streamAlive: true,
    streamKind: "zmq",
  });
  s.setProtocolT0(chain, protocolT0(chain));
  // Two calls: the tail only moves LEFT, so seed above then settle onto origin.
  s.setBackfillTail(chain, origin + 1);
  s.setBackfillTail(chain, origin);
  return s;
}

/** A tail well above t0, so there is genuinely past left to walk. */
function bitcoinWithPastRemaining() {
  const t0 = protocolT0("bitcoin");
  return storeAt("bitcoin", t0 + 50_000, t0 + 60_000);
}

test("the budget is a real ceiling, not an unbounded default", () => {
  ok(
    Number.isFinite(DEFAULT_TAPE_BUDGET_BYTES) && DEFAULT_TAPE_BUDGET_BYTES > 0,
    "an infinite or zero budget is the bug this exists to prevent",
  );
});

test("a tape under budget keeps walking its past", async () => {
  const store = bitcoinWithPastRemaining();
  let ingested = 0;
  const worker = new BackfillWorker({
    store,
    tapeUsage: () => 0.5, // half consumed
    async ingestRange(chain, from): Promise<Header | undefined> {
      ingested++;
      return { chain, height: from, hash: hx("0x01"), parentHash: hx("0x00") };
    },
  });
  const progress = await worker.step(["bitcoin"]);
  ok(progress, "a chain with remaining past must produce a step");
  ok(ingested > 0, "under budget, the epoch actually runs");
  ok(
    !/size budget/i.test(progress.reason ?? ""),
    "nothing should mention the budget while under it",
  );
});

/**
 * THE MUTATION TEST. Remove the gate in step() and this fails.
 *
 * It asserts the observable consequence -- no network call was made and the
 * tail did not move -- rather than a wall-clock or a log line. A previous bug
 * in this package passed a 2000ms assertion while taking 5,000,003 steps.
 */
test("a tape at budget refuses to walk, and never calls the network", async () => {
  const store = bitcoinWithPastRemaining();
  const before = store.getBackfillTail("bitcoin");
  let ingested = 0;
  const worker = new BackfillWorker({
    store,
    tapeUsage: () => 1, // exactly at the ceiling
    async ingestRange(chain, from): Promise<Header | undefined> {
      ingested++;
      return { chain, height: from, hash: hx("0x01"), parentHash: hx("0x00") };
    },
  });
  const progress = await worker.step(["bitcoin"]);
  ok(progress, "a held backfill must still REPORT -- silence reads as finished");
  eq(ingested, 0, "a full tape must cost nothing: no epoch, no network call");
  eq(progress.tailMoved, false, "the tail must not move while held");
  eq(store.getBackfillTail("bitcoin"), before, "and the stored pin is unchanged");
});

test("the refusal says it is paused, and does NOT read as a closed past", async () => {
  const store = bitcoinWithPastRemaining();
  const worker = new BackfillWorker({
    store,
    tapeUsage: () => 1.4, // over budget
    async ingestRange(): Promise<Header | undefined> {
      throw new Error("must not be reached while over budget");
    },
  });
  const progress = await worker.step(["bitcoin"]);
  ok(progress);
  const reason = progress.reason ?? "";
  ok(/size budget/i.test(reason), `the reason must name the budget; got: ${reason}`);
  ok(
    /NOT closed|paused/i.test(reason),
    `the reason must distinguish paused from finished; got: ${reason}`,
  );
  ok(/140\.0%|1\.4|%/.test(reason), `the reason should carry the measured usage; got: ${reason}`);
});

/**
 * An unmeasurable tape must not be treated as an empty one. This is the same
 * distinction the bridge draws between "no rows" and "no table", and the same
 * one `tapeBytes()` draws by returning undefined rather than 0.
 */
test("a store that cannot measure itself is not treated as empty", async () => {
  const store = bitcoinWithPastRemaining();
  let ingested = 0;
  const worker = new BackfillWorker({
    store,
    tapeUsage: () => undefined, // cannot measure
    async ingestRange(chain, from): Promise<Header | undefined> {
      ingested++;
      return { chain, height: from, hash: hx("0x01"), parentHash: hx("0x00") };
    },
  });
  const progress = await worker.step(["bitcoin"]);
  ok(progress);
  ok(ingested > 0, "an unmeasurable tape does not enforce the budget, so the walk proceeds");
  ok(!/size budget/i.test(progress.reason ?? ""), "and it must not claim to be held");
});

test("omitting tapeUsage entirely preserves the pre-budget behaviour", async () => {
  const store = bitcoinWithPastRemaining();
  let ingested = 0;
  const worker = new BackfillWorker({
    store,
    async ingestRange(chain, from): Promise<Header | undefined> {
      ingested++;
      return { chain, height: from, hash: hx("0x01"), parentHash: hx("0x00") };
    },
  });
  const progress = await worker.step(["bitcoin"]);
  ok(progress);
  ok(ingested > 0, "callers that never opt in are unaffected");
});
