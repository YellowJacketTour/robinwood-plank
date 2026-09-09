import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { BackfillWorker, type BackfillStore } from "../src/hose/backfill.ts";
import { PostgresArchiveStore } from "../src/hose/pg-store.ts";
import type { SqlClient } from "../src/hose/pg-store.ts";
import type { Header } from "../src/shared/types.ts";
import { asHex } from "../src/shared/hex.ts";

/**
 * A tail whose parent_hash is its OWN hash is not a reorg and not a
 * disagreement with the chain -- it is a placeholder that was never
 * overwritten. It is detectable by pure comparison: no vendor, no header
 * fetch, nothing that can fail.
 *
 * Measured live 2026-09-09: block 966081 stayed self-parented across multiple
 * worker boots while the backfill refused, correctly, every 15 seconds. The
 * repair existed only in the BOOT path, so a poisoned row discovered mid-run
 * waited for the next hourly restart -- and when that one boot-time header
 * read failed, it waited another hour.
 */

const TAIL = 966_081;
const hashAt = (n: number) => asHex("0x" + n.toString(16).padStart(64, "0"));

function fakeSql(): SqlClient {
  return { async query() { return { rows: [] as Record<string, unknown>[] }; } };
}

function storeWith(tailParent: string, below: number[]): PostgresArchiveStore {
  const s = new PostgresArchiveStore(fakeSql());
  s.putCursor({
    chain: "bitcoin",
    t0Height: TAIL,
    t0Hash: hashAt(TAIL),
    tipHeight: TAIL,
    tipHash: hashAt(TAIL),
    finalizedHeight: TAIL,
    finalizedHash: hashAt(TAIL),
    streamAlive: false,
    streamKind: "zmq",
  } as never);
  s.putHeader({ chain: "bitcoin", height: TAIL, hash: hashAt(TAIL), parentHash: asHex(tailParent) } as Header);
  for (const n of below) {
    s.putHeader({ chain: "bitcoin", height: TAIL - 1, hash: hashAt(n), parentHash: hashAt(n - 1) } as Header);
  }
  s.setBackfillTail("bitcoin", TAIL);
  return s;
}

/** ingestRange that reports it persisted the block below the tail. */
function ingestBelow(store: PostgresArchiveStore) {
  return async (): Promise<Header | undefined> =>
    store.headersAtHeight("bitcoin", TAIL - 1)[0];
}

test("THE GUARD FIRES: a self-parented tail is repaired in place, no network", async () => {
  // parent == own hash, and exactly one header below.
  const store = storeWith(hashAt(TAIL), [TAIL - 1]);
  const worker = new BackfillWorker({
    store: store as unknown as BackfillStore,
    ingestRange: ingestBelow(store) as never,
  });

  const before = store.headersAtHeight("bitcoin", TAIL)[0]!.parentHash;
  eq(before.toLowerCase(), hashAt(TAIL).toLowerCase(), "precondition: the row is self-parented");

  const res = (await worker.step(["bitcoin"] as never))!;
  ok(/repaired in place/.test(res.reason ?? ""), `expected an in-place repair, got: ${res.reason}`);

  const after = store.headersAtHeight("bitcoin", TAIL)[0]!.parentHash;
  eq(after.toLowerCase(), hashAt(TAIL - 1).toLowerCase(), "the parent must now be the block below");
  eq(res.tailMoved, false, "this epoch does not move the tail -- the NEXT one links");
});

test("after the repair, the very next epoch links and the tail MOVES", async () => {
  const store = storeWith(hashAt(TAIL), [TAIL - 1]);
  const worker = new BackfillWorker({
    store: store as unknown as BackfillStore,
    ingestRange: ingestBelow(store) as never,
  });
  await worker.step(["bitcoin"] as never); // repair
  const second = (await worker.step(["bitcoin"] as never))!;
  ok(second.linked, `the repaired link must hold: ${second.reason}`);
  ok(store.getBackfillTail("bitcoin")! < TAIL, "the tail must fall once the link is real");
});

test("A GENUINE MISMATCH IS STILL REFUSED", async () => {
  // Parent is some OTHER hash -- a real claim about the chain. Repairing that
  // from local data would be inventing history.
  const other = hashAt(123_456);
  const store = storeWith(other, [TAIL - 1]);
  const worker = new BackfillWorker({
    store: store as unknown as BackfillStore,
    ingestRange: ingestBelow(store) as never,
  });
  const res = (await worker.step(["bitcoin"] as never))!;
  ok(!/repaired in place/.test(res.reason ?? ""), "a non-self-parent must NOT be rewritten");
  ok(/did not hash-link/.test(res.reason ?? ""), "it must still refuse, and say so");
  eq(
    store.headersAtHeight("bitcoin", TAIL)[0]!.parentHash.toLowerCase(),
    other.toLowerCase(),
    "the stored parent must be untouched",
  );
});

test("AMBIGUITY IS REFUSED: two headers below means no unique repair", async () => {
  // Competing blocks at the height below is exactly when guessing is wrong.
  const store = storeWith(hashAt(TAIL), [TAIL - 1, 555_555]);
  const worker = new BackfillWorker({
    store: store as unknown as BackfillStore,
    ingestRange: ingestBelow(store) as never,
  });
  const res = (await worker.step(["bitcoin"] as never))!;
  ok(!/repaired in place/.test(res.reason ?? ""), "an ambiguous height must not be repaired");
  eq(
    store.headersAtHeight("bitcoin", TAIL)[0]!.parentHash.toLowerCase(),
    hashAt(TAIL).toLowerCase(),
    "the stored parent must be untouched",
  );
});

test("putHeader REPLACES an existing hash, it does not silently skip", async () => {
  // The real defect underneath all of this. putHeader was
  //   if (!arr.some(x => x.hash === h.hash)) arr.push(h)
  // so re-putting an EXISTING hash updated the `headers` map and left the
  // by-height array holding the OLD object. Every correction to a header was
  // invisible to headersAtHeight -- which is exactly what the backfill's
  // hash-link check reads.
  //
  // Two maps disagreeing silently: a repair could report success while the
  // value the reader sees never changed.
  const s = new PostgresArchiveStore(fakeSql());
  s.putHeader({ chain: "bitcoin", height: TAIL, hash: hashAt(TAIL), parentHash: hashAt(TAIL) } as Header);
  s.putHeader({ chain: "bitcoin", height: TAIL, hash: hashAt(TAIL), parentHash: hashAt(TAIL - 1) } as Header);

  const byHeight = s.headersAtHeight("bitcoin", TAIL);
  eq(byHeight.length, 1, "a re-put of the same hash must not duplicate the row");
  eq(
    byHeight[0]!.parentHash.toLowerCase(),
    hashAt(TAIL - 1).toLowerCase(),
    "headersAtHeight must see the CORRECTED parent, not the stale one",
  );
  eq(
    s.getHeader("bitcoin", hashAt(TAIL))!.parentHash.toLowerCase(),
    byHeight[0]!.parentHash.toLowerCase(),
    "the two maps must never disagree",
  );
});
