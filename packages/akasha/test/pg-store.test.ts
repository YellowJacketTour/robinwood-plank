/**
 * The durable tape.
 *
 * The property that makes an asynchronous write-through store acceptable for
 * an archive: a lost write must degrade to "not yet covered", never to
 * "covered but wrong". Coverage is a run-list, so a dropped write reopens a
 * hole and a hole is a first-class object the gap worker absorbs. These tests
 * pin that, plus the two rules a tape cannot survive losing -- delete by hash,
 * and a backfill tail that only moves left.
 */
import { test } from "node:test";
import { eq, ok, sha256Stub } from "./_expect.ts";
import { PostgresArchiveStore, type SqlClient } from "../src/hose/pg-store.ts";
import type { ChainEvent, ChainId, Header } from "../src/shared/types.ts";

const CHAIN: ChainId = "bitcoin";
const hx = (s: string) => s as `0x${string}`;
const sha = sha256Stub();

/** Records SQL instead of running it, so the durable intent is inspectable. */
function fakeSql(): SqlClient & { ops: Array<{ sql: string; values: unknown[] }>; fail?: string } {
  const self = {
    ops: [] as Array<{ sql: string; values: unknown[] }>,
    fail: undefined as string | undefined,
    async query(sql: string, values: unknown[] = []) {
      if (self.fail && sql.includes(self.fail)) throw new Error(`boom: ${self.fail}`);
      self.ops.push({ sql, values });
      return { rows: [] as Record<string, unknown>[] };
    },
  };
  return self;
}

function header(height: number, hash: string, parent: string): Header {
  return { chain: CHAIN, height, hash: hx(hash), parentHash: hx(parent) };
}

function event(height: number, blockHash: string, token: string): ChainEvent {
  return {
    chain: CHAIN,
    blockHash: hx(blockHash),
    height,
    loc: 0,
    txHash: hx("0x" + "11".repeat(32)),
    kind: "envelope",
    contractOrProgram: "ord",
    tokenOrInscription: token,
    fromAddr: "",
    toAddr: "",
    raw: {},
  };
}

test("reads stay synchronous while writes are queued for durability", () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  store.putHeader(header(1, "0xaa", "0x00"));
  store.putEvent(event(1, "0xaa", "i0"));

  // The read model is live immediately -- an await here would serialise block
  // ingest behind network latency.
  eq(store.eventsInBlock(CHAIN, "0xaa").length, 1);
  eq(sql.ops.length, 0, "nothing has hit the database yet");
  ok(store.pendingWrites >= 2, "but both mutations are queued");
});

test("flush drains in order: events land before the coverage run that counts them", async () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  store.putEvent(event(1, "0xaa", "i0"));
  store.putCoverage({
    chain: CHAIN,
    fromHeight: 1,
    toHeight: 1,
    toHash: hx("0xaa"),
    eventCount: 1,
    artifactCount: 0,
    receiptDigest: sha(new Uint8Array()),
  });

  eq(await store.flush(), 2);
  const kinds = sql.ops.map((o) => (o.sql.includes("akasha_event") ? "event" : "coverage"));
  eq(kinds, ["event", "coverage"], "a reader between the two must never see a covered empty range");
  eq(store.pendingWrites, 0);
});

test("a failed flush RETAINS the tape instead of dropping it", async () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  store.putEvent(event(1, "0xaa", "i0"));
  store.putEvent(event(2, "0xbb", "i1"));
  sql.fail = "akasha_event";

  await store.flush().then(
    () => ok(false, "should have thrown"),
    (e: Error) => ok(/boom/.test(e.message)),
  );
  ok(store.pendingWrites >= 2, "unwritten tape stays queued for the next attempt");
  ok(store.lastError(), "and the failure is reported, not swallowed");

  // Recovery: the same writes go through once the database is back.
  sql.fail = undefined;
  ok((await store.flush()) >= 2, "retry drains what the failure left behind");
  eq(store.pendingWrites, 0);
});

test("a re-seen event is not written twice", () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  const e = event(1, "0xaa", "i0");
  eq(store.putEvent(e), true);
  const after = store.pendingWrites;
  eq(store.putEvent(e), false, "already on the tape");
  eq(store.pendingWrites, after, "and no duplicate durable write was queued");
});

test("deletion is by BLOCK HASH, never by height", async () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  store.putEvent(event(2, "0xaa", "orphan"));
  store.putEvent(event(2, "0xbb", "sibling-same-height"));
  await store.flush();
  sql.ops.length = 0;

  store.deleteEventsByHashes(CHAIN, ["0xaa"]);
  await store.flush();

  const del = sql.ops.find((o) => o.sql.startsWith("DELETE"));
  ok(del, "a delete was issued");
  ok(
    del!.sql.includes("block_hash = ANY"),
    "height-scoped deletion would take the surviving branch's sibling with the orphan",
  );
  eq(
    store.eventsInBlock(CHAIN, "0xbb").length,
    1,
    "the same-height sibling on the surviving branch is untouched",
  );
});

test("the backfill tail moves LEFT only", () => {
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);
  store.setBackfillTail(CHAIN, 800_000);
  eq(store.getBackfillTail(CHAIN), 800_000);

  eq(store.setBackfillTail(CHAIN, 790_000), true, "leftward is the past being walked");
  eq(store.getBackfillTail(CHAIN), 790_000);

  eq(store.setBackfillTail(CHAIN, 795_000), false, "a tail that advances would claim dropped history");
  eq(store.setBackfillTail(CHAIN, 790_000), false, "and standing still is not progress");
  eq(store.getBackfillTail(CHAIN), 790_000);
});

test("load() rebuilds the read model and never trusts a persisted liveness bit", async () => {
  const rows: Record<string, Record<string, unknown>[]> = {
    akasha_cursor: [
      {
        chain: "bitcoin",
        protocol_t0: 767_430,
        t0_hash: Buffer.from("aa", "hex"),
        t0_height: 900_000,
        tip_hash: Buffer.from("bb", "hex"),
        tip_height: 900_010,
        finalized_hash: Buffer.from("cc", "hex"),
        finalized_height: 900_004,
        backfill_tail: 899_000,
        stream_alive: true, // persisted as alive
        stream_kind: "zmq",
      },
    ],
    akasha_header: [
      { chain: "bitcoin", hash: Buffer.from("bb", "hex"), parent_hash: Buffer.from("aa", "hex"), height: 900_010 },
    ],
    akasha_coverage_run: [
      {
        chain: "bitcoin",
        from_height: 900_000,
        to_height: 900_010,
        to_hash: Buffer.from("bb", "hex"),
        event_count: 5,
        artifact_count: 1,
        receipt_digest: Buffer.from("dd", "hex"),
      },
    ],
  };
  const sql: SqlClient = {
    async query(text: string) {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "5" }] };
      const table = Object.keys(rows).find((t) => text.includes(t));
      return { rows: table ? rows[table]! : [] };
    },
  };

  const store = new PostgresArchiveStore(sql);
  const restored = await store.load();
  eq(restored.cursors, 1);
  eq(restored.events, 5);

  const cursor = store.getCursor("bitcoin")!;
  eq(cursor.finalizedHeight, 900_004);
  eq(
    cursor.streamAlive,
    false,
    "liveness is a claim about NOW; a restart must re-earn it from coverage",
  );
  eq(store.protocolT0.get("bitcoin"), 767_430, "the protocol pin survives a restart");
  eq(store.getBackfillTail("bitcoin"), 899_000, "and so does the tail's position");
  eq(store.coverageFor("bitcoin").length, 1);

  // load() replays through the parent class, so restoring must not re-queue
  // every restored row as a fresh durable write.
  eq(store.pendingWrites, 0, "restoring the read model is not a reason to rewrite the tape");
});

test("protocol_t0 is NEVER stamped from the cursor's lock height", async () => {
  // The bug this pins, found by running a real restart against mainnet:
  // putCursor fell back to `c.t0Height` when the pin was not yet installed.
  // bootBitcoin writes a cursor BEFORE initPins runs, so the CURRENT TIP was
  // persisted as the protocol origin -- and complete_from_protocol is
  // `backfill_tail <= protocol_t0`, so a chain holding one block would have
  // declared itself complete from genesis. A forged completeness certificate,
  // produced by a convenience default.
  const sql = fakeSql();
  const store = new PostgresArchiveStore(sql);

  // Deliberately do NOT call setProtocolT0 first: this is the boot order.
  store.putCursor({
    chain: "bitcoin",
    t0Hash: hx("0xaa"),
    t0Height: 966_035, // a live tip height
    tipHash: hx("0xaa"),
    tipHeight: 966_035,
    finalizedHash: hx("0xaa"),
    finalizedHeight: 966_035,
    streamAlive: false,
    streamKind: "zmq",
  });
  await store.flush();

  const write = sql.ops.find((o) => o.sql.includes("INSERT INTO akasha_cursor"));
  ok(write, "a cursor write was issued");
  const persistedT0 = write!.values[1];
  eq(persistedT0, 767_430, "protocol_t0 must be the reviewed constant, not the lock height");
  ok(persistedT0 !== 966_035, "stamping the tip as the origin forges completeness");
});
