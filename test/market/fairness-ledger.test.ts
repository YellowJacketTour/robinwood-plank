import assert from "node:assert/strict";
import test from "node:test";
import { appendFairnessEntry, persistFairnessEntry, readFairnessLedger } from "../../public/arcade/fairness-ledger.js";

const proof = { roomId: "room-a", round: "7", commitment: "a".repeat(64), reveal: "b".repeat(64), crashBps: "24500", verifiedAt: "2026-08-31T00:00:00.000Z" };

test("fairness ledger is append-only and idempotent", () => {
  const once = appendFairnessEntry([], proof);
  assert.deepEqual(appendFairnessEntry(once, proof), once);
  assert.throws(() => appendFairnessEntry(once, { ...proof, crashBps: "24501" }), /FAIRNESS_EQUIVOCATION/);
});

test("fairness ledger bounds browser storage", () => {
  let entries: unknown[] = [];
  for (let round = 1; round <= 205; round += 1) entries = appendFairnessEntry(entries, { ...proof, round: String(round) });
  assert.equal(entries.length, 200);
  assert.equal((entries[0] as { round: string }).round, "6");
});

test("fairness ledger persists and rejects malformed storage", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  persistFairnessEntry(storage, proof);
  assert.equal(readFairnessLedger(storage).length, 1);
  values.set("plankcrash:fairness-ledger:v1", "broken");
  assert.deepEqual(readFairnessLedger(storage), []);
});

