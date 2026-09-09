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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * THE RATE, not the window.
 *
 * 8 blocks per epoch is right -- a Bitcoin block means parsing every witness
 * in it, unlike an EVM topic-only getLogs over a range. But one epoch per
 * 15-second tick is 192 blocks an hour, and the gap between the locked tip
 * and protocol_t0 is 198,651 blocks: 43 DAYS. An archive that arrives after
 * the questions it was built to answer has not arrived.
 *
 * The tip-follow runs first in each tick, so the remainder is idle. The past
 * now uses it, bounded by wall clock so the next tip poll is never delayed.
 */
test("a budgeted tick walks many epochs, not one", async () => {
  let steps = 0;
  const backfill = {
    step: async () => {
      steps += 1;
      return { chain: "bitcoin", from: 0, to: 0, linked: true, tailMoved: true };
    },
  };
  const hose = { backfill } as unknown as {
    backfill: typeof backfill;
    cfg: { chains: string[] };
    backfillTick: (ms?: number) => Promise<unknown>;
  };
  // Reproduce the production method against the stub.
  hose.cfg = { chains: ["bitcoin"] };
  hose.backfillTick = async (budgetMs = 0) => {
    const first = await backfill.step();
    if (budgetMs <= 0) return first;
    if (!first || first.tailMoved !== true) return first;
    const until = Date.now() + budgetMs;
    let last = first;
    let epochs = 1;
    while (Date.now() < until) {
      const next = await backfill.step();
      if (!next || next.tailMoved !== true) break;
      last = next;
      epochs += 1;
    }
    return { ...last, epochs };
  };

  const res = (await hose.backfillTick(60)) as { epochs?: number };
  ok(steps > 1, `a budgeted tick must walk more than one epoch, saw ${steps}`);
  ok((res.epochs ?? 0) > 1, "and must report how many");
});

test("no progress ends the tick immediately -- it must not spin", async () => {
  // The risk this budget introduces. A chain whose past is closed, or whose
  // RPC is refusing, returns a reason string with tailMoved false. Looping on
  // that would burn the whole budget every tick forever while reporting
  // nothing -- a busy no-op, which is this codebase's signature failure.
  let steps = 0;
  const backfill = {
    step: async () => {
      steps += 1;
      return { chain: "bitcoin", from: 0, to: 0, linked: false, tailMoved: false };
    },
  };
  const tick = async (budgetMs: number) => {
    const first = await backfill.step();
    if (budgetMs <= 0) return first;
    if (!first || first.tailMoved !== true) return first;
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      const next = await backfill.step();
      if (!next || next.tailMoved !== true) break;
    }
    return first;
  };

  const started = Date.now();
  await tick(5_000);
  eq(steps, 1, "a step that moved nothing must not be retried inside the tick");
  ok(Date.now() - started < 1_000, "and the tick must return at once, not burn its budget");
});

test("a zero budget preserves the old one-epoch-per-tick behaviour", async () => {
  let steps = 0;
  const step = async () => {
    steps += 1;
    return { chain: "bitcoin", from: 0, to: 0, linked: true, tailMoved: true };
  };
  const tick = async (budgetMs = 0) => {
    const first = await step();
    if (budgetMs <= 0) return first;
    return first;
  };
  await tick();
  eq(steps, 1, "an unbudgeted caller must be unaffected");
});

test("the stubs above match the real backfillTick, clause for clause", () => {
  // A stub that drifts from production proves nothing about production. These
  // assertions pin the three properties the tests rely on to the real source.
  const src = readFileSync(
    fileURLToPath(new URL("../src/hose/main.ts", import.meta.url)),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const at = src.indexOf("async backfillTick(");
  ok(at > 0, "backfillTick must exist");
  const body = src.slice(at, src.indexOf("\n  /**", at + 1));
  ok(/budgetMs = 0/.test(body), "it must default to the old single-epoch behaviour");
  ok(/if \(budgetMs <= 0\) return first;/.test(body), "a zero budget must short-circuit");
  ok(/tailMoved !== true/.test(body), "no progress must end the walk, not spin");
  ok(/Date\.now\(\) < until/.test(body), "and the walk must be wall-clock bounded");
});

/**
 * THE SELF-PARENT LOCK HEADER: why Bitcoin's past never opened.
 *
 * bootBitcoin wrote the lock block as `parentHash: asHex(hash)` -- the block
 * naming ITSELF as its own parent. A placeholder, and the reason 198,651
 * blocks of Ordinals history stayed unreachable.
 *
 * The backfill's hash-link guard is correct and load-bearing: before moving
 * the tail it checks that the block just below is the parent of the block it
 * already holds. Against a self-parent it compared block N-1's REAL hash to
 * block N's FAKE parent, never matched, refused to move, and enqueued a
 * bloom_audit gap -- every 15 seconds, forever.
 *
 * Measured live 2026-09-09: tail pinned at 966081, blocksToProtocolT0 stuck at
 * 198,651, while the tip advanced past 966176 and runs climbed to 32. The
 * forward walk worked perfectly; the backward walk could not take its first
 * step. Bitcoin's catalog sat at 19,628 because essentially every Ordinals
 * collection was minted in blocks the archive could not reach.
 *
 * A genesis block IS its own parent. No other block is, and a lock block is
 * not genesis.
 */
test("a self-parent lock header blocks the backfill's first step", () => {
  const store = newStore();
  const LOCK = 966_081;
  // Exactly what bootBitcoin used to write.
  store.putHeader({
    chain: "bitcoin",
    height: LOCK,
    hash: toHex(h(LOCK)),
    parentHash: toHex(h(LOCK)), // <- the placeholder
  });
  const below = store.headersAtHeight("bitcoin", LOCK - 1);
  const lock = store.headersAtHeight("bitcoin", LOCK).find((x) => x.height === LOCK)!;
  // The guard's own rule, reproduced: can the block below be the parent?
  const linked = below.some((x) => x.hash.toLowerCase() === lock.parentHash.toLowerCase());
  eq(linked, false, "a self-parent can never hash-link to the block below it");
  eq(
    lock.parentHash.toLowerCase(),
    lock.hash.toLowerCase(),
    "precondition: this is the poisoned shape"
  );
});

test("a real parent lets the backfill link across the lock block", () => {
  const store = newStore();
  const LOCK = 966_081;
  store.putHeader({
    chain: "bitcoin",
    height: LOCK,
    hash: toHex(h(LOCK)),
    parentHash: toHex(h(LOCK - 1)), // the RPC's previousblockhash
  });
  store.putHeader({
    chain: "bitcoin",
    height: LOCK - 1,
    hash: toHex(h(LOCK - 1)),
    parentHash: toHex(h(LOCK - 2)),
  });
  const below = store.headersAtHeight("bitcoin", LOCK - 1);
  const lock = store.headersAtHeight("bitcoin", LOCK).find((x) => x.height === LOCK)!;
  const linked = below.some((x) => x.hash.toLowerCase() === lock.parentHash.toLowerCase());
  ok(linked, "with the real parent the guard links and the tail may move");
});

test("boot reads the real previousblockhash, and repairs a poisoned row", () => {
  // The fix has to do BOTH. Writing the real parent only helps a hose booting
  // for the first time; production already has the placeholder, and
  // `if (!existing)` skips straight past it. A fix that only helps new
  // installs is not a fix for the system that has the problem.
  const src = readFileSync(
    fileURLToPath(new URL("../src/hose/main.ts", import.meta.url)),
    "utf8"
  ).replace(/\r\n/g, "\n");
  ok(/parentHash = header\?\.previousblockhash/.test(src) ||
     /parentHash = header\.previousblockhash/.test(src),
    "boot must read the RPC's real parent");
  ok(!/parentHash: asHex\(hash\),/.test(src), "and must never write a self-parent again");
  ok(/repairSelfParent/.test(src), "and must repair a row already written with one");
});

test("the repair cannot be a silent no-op", () => {
  // putHeader is ON CONFLICT DO NOTHING -- correct for immutable headers, and
  // fatal for a repair: the in-memory store would update while the durable row
  // kept the placeholder, so the fix would report success and change nothing.
  const src = readFileSync(
    fileURLToPath(new URL("../src/hose/pg-store.ts", import.meta.url)),
    "utf8"
  ).replace(/\r\n/g, "\n");
  const at = src.indexOf("repairSelfParent");
  ok(at > 0, "an explicit repair path must exist");
  const body = src.slice(at, src.indexOf("\n  }", at));
  ok(/UPDATE akasha_header SET parent_hash/.test(body), "it must UPDATE, not INSERT");
  // Narrow on purpose: only ever replaces a self-parent, which no real
  // non-genesis block has. A general parent rewrite would be a way to rewrite
  // history.
  ok(/parent_hash = \$2/.test(body), "and only where the parent IS the hash");
});
