/**
 * Bitcoin's backfill must actually walk LEFT.
 *
 * `BackfillWorker` was wired into production and called every 15 seconds, and
 * for Bitcoin it was a hard no-op: `ingestRange` looked only in the EVM
 * adapter map, Bitcoin lives in its own field with no `endpoints` entry, so
 * every call returned `undefined` and the worker reported
 * "epoch produced no header" -- forever.
 *
 * Measured on production 2026-09-09:
 *
 *   bitcoin  backfill_tail=966081  protocol_t0=767430  blocksToProtocolT0=198651
 *
 * The tail sat exactly where the hose had locked. Nothing crashed; the reason
 * string read like a quiet chain. Same species as every other bug in this
 * package: a miss indistinguishable from "nothing happened".
 *
 * A leftward walk needs a height -> hash lookup, which the forward walk never
 * does (it follows parent links from the tip). That is why `getBlockHashAtHeight`
 * exists on the RPC interface.
 */
import { test } from "node:test";
import { eq, ok, sha256Stub } from "./_expect.ts";
import { PostgresArchiveStore, type SqlClient } from "../src/hose/pg-store.ts";
import { BitcoinAdapter, toHex, type BitcoinRpc } from "../src/hose/adapters/bitcoin.ts";
import { BackfillWorker } from "../src/hose/backfill.ts";

const T0 = 767_430;
const LOCKED = 966_081;

function h(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A chain where every height resolves, so only the walk itself is under test. */
function heightAddressableRpc(): BitcoinRpc & { blocksFetched: number[] } {
  const fetched: number[] = [];
  return {
    blocksFetched: fetched,
    getBestBlockHash: async () => h(LOCKED),
    getBlockHashAtHeight: async (height: number) => h(height),
    getBlockHeader: async (hash: string) => {
      const height = parseInt(hash, 16);
      return { hash, previousblockhash: h(height - 1), height };
    },
    getBlock: async (hash: string) => {
      const height = parseInt(hash, 16);
      fetched.push(height);
      return { hash, height, previousblockhash: h(height - 1), tx: [] };
    },
  } as unknown as BitcoinRpc & { blocksFetched: number[] };
}

/** Queued writes go nowhere; the read model is what these tests exercise. */
function fakeSql(): SqlClient {
  return { async query() { return { rows: [] as Record<string, unknown>[] }; } };
}

function newStore(): PostgresArchiveStore {
  return new PostgresArchiveStore(fakeSql());
}

function seeded(store: PostgresArchiveStore): void {
  store.putCursor({
    chain: "bitcoin",
    t0Height: LOCKED,
    t0Hash: toHex(h(LOCKED)),
    tipHeight: LOCKED,
    tipHash: toHex(h(LOCKED)),
    finalizedHeight: LOCKED,
    finalizedHash: toHex(h(LOCKED)),
    streamAlive: false,
    streamKind: "zmq",
  } as never);
  store.putHeader({
    chain: "bitcoin",
    height: LOCKED,
    hash: toHex(h(LOCKED)),
    parentHash: toHex(h(LOCKED - 1)),
  });
  store.setBackfillTail("bitcoin", LOCKED);
}

/** The production wiring, reproduced: the ingestRange a Bitcoin hose installs. */
function bitcoinIngestRange(store: PostgresArchiveStore, adapter: BitcoinAdapter, rpc: BitcoinRpc) {
  return async (chain: string, from: number, to: number) => {
    if (chain !== "bitcoin") return undefined;
    if (!rpc.getBlockHashAtHeight) return undefined;
    let lowest;
    for (let x = to; x >= from; x--) {
      const hash = await rpc.getBlockHashAtHeight(x);
      if (!hash) continue;
      await adapter.ingestBlock(hash);
      const stored = store.headersAtHeight("bitcoin", x);
      const header = stored[stored.length - 1];
      if (header) lowest = header;
    }
    return lowest;
  };
}

test("the backfill moves bitcoin's tail LEFT, toward protocol_t0", async () => {
  const store = newStore();
  seeded(store);
  const rpc = heightAddressableRpc();
  const adapter = new BitcoinAdapter({ store, rpc, sha256: sha256Stub() });
  const worker = new BackfillWorker({
    store,
    ingestRange: bitcoinIngestRange(store, adapter, rpc) as never,
  });

  const before = store.getBackfillTail("bitcoin");
  eq(before, LOCKED, "precondition: the tail starts where the hose locked");

  await worker.step(["bitcoin"] as never);

  const after = store.getBackfillTail("bitcoin");
  ok(after !== undefined && after < before!, `the tail must fall; ${before} -> ${after}`);
  ok(rpc.blocksFetched.length > 0, "the walk must actually fetch blocks");
});

test("the walk descends and never runs past protocol_t0", async () => {
  const store = newStore();
  seeded(store);
  const rpc = heightAddressableRpc();
  const adapter = new BitcoinAdapter({ store, rpc, sha256: sha256Stub() });
  const worker = new BackfillWorker({
    store,
    ingestRange: bitcoinIngestRange(store, adapter, rpc) as never,
  });

  for (let i = 0; i < 6; i++) await worker.step(["bitcoin"] as never);

  const tail = store.getBackfillTail("bitcoin")!;
  ok(tail < LOCKED, "six epochs must have moved the tail");
  ok(tail >= T0, `the tail must never go below protocol_t0 (${tail} < ${T0})`);
  // Strictly descending: a walk that revisits the same heights is not progress.
  const sorted = [...rpc.blocksFetched].sort((a, b) => b - a);
  eq(rpc.blocksFetched, sorted, "blocks must be fetched newest-first, descending");
});

test("blocks walked by the backfill are recorded as covered", async () => {
  // The two halves have to hold together: walking without recording coverage
  // is the bug that made run_count 0 while the tape filled with real data.
  const store = newStore();
  seeded(store);
  const rpc = heightAddressableRpc();
  const adapter = new BitcoinAdapter({ store, rpc, sha256: sha256Stub() });
  const worker = new BackfillWorker({
    store,
    ingestRange: bitcoinIngestRange(store, adapter, rpc) as never,
  });

  await worker.step(["bitcoin"] as never);

  const runs = store.coverageFor("bitcoin");
  ok(runs.length > 0, "a backfilled epoch must leave coverage behind");
  const covered = new Set<number>();
  for (const r of runs) for (let x = r.fromHeight; x <= r.toHeight; x++) covered.add(x);
  for (const height of rpc.blocksFetched) {
    ok(covered.has(height), `walked block ${height} is not covered`);
  }
});

test("an RPC with no height lookup cannot silently no-op forever", async () => {
  // The exact production failure: ingestRange returned undefined every time
  // and the worker reported a benign reason. It is legal to make no progress,
  // but it must be VISIBLE as no progress -- the tail must not move, and the
  // caller must be able to tell.
  const store = newStore();
  seeded(store);
  const rpc = heightAddressableRpc();
  delete (rpc as { getBlockHashAtHeight?: unknown }).getBlockHashAtHeight;
  const adapter = new BitcoinAdapter({ store, rpc, sha256: sha256Stub() });
  const worker = new BackfillWorker({
    store,
    ingestRange: bitcoinIngestRange(store, adapter, rpc) as never,
  });

  const res = await worker.step(["bitcoin"] as never);

  eq(store.getBackfillTail("bitcoin"), LOCKED, "the tail must not move");
  eq(res?.tailMoved, false, "and the worker must report that it did not move");
});
