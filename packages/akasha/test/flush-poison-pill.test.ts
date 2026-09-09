import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { PostgresArchiveStore } from "../src/hose/pg-store.ts";

/**
 * Measured live 2026-09-09, from the worker's own health line:
 *
 *   pendingWrites: 69,
 *   lastWriteError: "inconsistent types deduced for parameter $3"
 *
 * One malformed statement (a missing cast in recordPhase) failed, the flush
 * pushed the whole remainder back at the FRONT of an ordered queue, and the
 * same bad statement was retried first forever. Every valid write queued
 * behind it never landed -- the archive's writes stopped completely.
 *
 * The instrument built to explain a stall caused one.
 */

function storeWith(behaviour: (sql: string) => void) {
  const seen: string[] = [];
  const sql = {
    query: async (text: string) => {
      seen.push(text);
      behaviour(text);
      return { rows: [] };
    },
  };
  return { store: new PostgresArchiveStore(sql as never), seen };
}

test("a MALFORMED statement is dropped, not retried forever", async () => {
  const { store, seen } = storeWith((text) => {
    if (text.includes("POISON")) {
      const e = new Error("inconsistent types deduced for parameter $3");
      (e as { code?: string }).code = "42804"; // datatype_mismatch
      throw e;
    }
  });
  const q = store as unknown as { pending: Array<{ sql: string; values: unknown[] }> };
  q.pending = [
    { sql: "POISON", values: [] },
    { sql: "GOOD ONE", values: [] },
    { sql: "GOOD TWO", values: [] },
  ];

  await store.flush().catch(() => undefined);

  ok(seen.includes("GOOD ONE"), "a valid write behind the poison must still land");
  ok(seen.includes("GOOD TWO"), "and so must the next one");
  eq(q.pending.length, 0, "the queue must drain, not stay blocked");
  eq(store.poisoned.length, 1, "the dropped statement must be RECORDED, not lost silently");
  ok(store.poisoned[0]!.error.includes("inconsistent types"), "with the reason attached");
});

test("a CONNECTION error still requeues everything, in order", async () => {
  // The behaviour that was always correct: a transient failure must not drop
  // data. Only a failure that retrying cannot fix is discarded.
  let fail = true;
  const { store, seen } = storeWith((text) => {
    if (fail && text === "B") {
      const e = new Error("connection terminated");
      (e as { code?: string }).code = "08006";
      throw e;
    }
  });
  const q = store as unknown as { pending: Array<{ sql: string; values: unknown[] }> };
  q.pending = [{ sql: "A", values: [] }, { sql: "B", values: [] }, { sql: "C", values: [] }];

  await store.flush().catch(() => undefined);
  eq(store.poisoned.length, 0, "a transient failure is not poison");
  eq(q.pending.map((p) => p.sql).join(","), "B,C", "the remainder requeues at the FRONT, in order");

  fail = false;
  await store.flush();
  eq(seen.filter((s) => s === "C").length, 1, "and drains once the connection returns");
});

test("every placeholder reused in a CASE is explicitly cast", async () => {
  // The actual defect: $3 was both a BIGINT column value and a `CASE WHEN $3
  // = 1` comparison, so Postgres could not deduce one type and rejected the
  // whole statement.
  const { store, seen } = storeWith(() => {});
  store.recordPhase("bitcoin" as never, "backfill", "attempt");
  store.recordHeartbeat("akasha-hose", {
    pid: 1,
    bootAt: new Date().toISOString(),
    chains: "bitcoin",
    version: "test",
    boot: true,
  });
  await store.flush();

  for (const text of seen) {
    for (const m of text.matchAll(/CASE WHEN (\$\d+)(::[a-z]+)?/g)) {
      ok(m[2], `${m[1]} is compared in a CASE without an explicit cast`);
    }
  }
});
