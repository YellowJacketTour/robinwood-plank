/**
 * Bitcoin must record COVERAGE, not just headers and events.
 *
 * Found live 2026-09-09, minutes after the existence cutover was armed. The
 * hose had been walking Bitcoin blocks for hours and the read-back said:
 *
 *   bitcoin t0=767430 tail=966081 fin=966081 runs=0 toT0=198651 alive=False
 *
 * `runs=0` with a real tip and real stored events. The blocks were being
 * ingested -- headers written, envelopes parsed, artifacts minted -- and
 * NOTHING recorded that the range had been covered.
 *
 * The cause: `extendCoverage()` was called from the EVM adapter only.
 * Bitcoin's `ingestBlock` wrote a header and returned. So every Bitcoin
 * block was archived and simultaneously unaccounted for.
 *
 * This is the house failure species in its purest form -- a miss that
 * reports finished. Nothing crashed, the log looked healthy, the tape filled
 * with real data, and the one number that says "we have this range" stayed
 * empty. And because `complete_from_protocol` requires `run_count = 1`, a
 * chain that records no runs can never claim completeness: the archive was
 * safe from lying, but permanently unable to tell the truth either.
 */
import { test } from "node:test";
import { eq, ok, sha256Stub } from "./_expect.ts";
import { ArchiveStore } from "../src/hose/store.ts";
import { BitcoinAdapter, toHex, type BitcoinRpc } from "../src/hose/adapters/bitcoin.ts";
import { assertCoverage } from "../src/hose/coverage.ts";

const T0 = 767_430;

function h(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A chain of empty blocks -- no envelopes needed to test coverage. */
function fakeRpc(heights: number[]): BitcoinRpc {
  const byHash = new Map<string, { hash: string; previousblockhash: string | null; height: number }>();
  for (const n of heights) {
    byHash.set(h(n), { hash: h(n), previousblockhash: n > heights[0]! ? h(n - 1) : null, height: n });
  }
  const best = h(heights[heights.length - 1]!);
  return {
    getBestBlockHash: async () => best,
    getBlock: async (hash: string) => {
      const hdr = byHash.get(hash);
      return hdr ? { ...hdr, tx: [] } : null;
    },
    getBlockHeader: async (hash: string) => byHash.get(hash) ?? null,
  } as unknown as BitcoinRpc;
}

function seededStore(): ArchiveStore {
  const store = new ArchiveStore();
  store.putCursor({
    chain: "bitcoin",
    t0Height: T0,
    t0Hash: toHex(h(T0)),
    tipHeight: T0,
    tipHash: toHex(h(T0)),
    finalizedHeight: T0,
    finalizedHash: toHex(h(T0)),
    backfillTail: T0,
    streamAlive: false,
    streamKind: "zmq",
    protocolT0: T0,
  } as never);
  return store;
}

test("ingesting a bitcoin block records a coverage run for it", async () => {
  const store = seededStore();
  const adapter = new BitcoinAdapter({ store, rpc: fakeRpc([T0, T0 + 1, T0 + 2]), sha256: sha256Stub() });

  await adapter.ingestBlock(h(T0 + 1));

  const runs = store.coverageFor("bitcoin");
  ok(runs.length > 0, "an ingested block must leave a coverage run behind");
  ok(
    runs.some((r) => r.fromHeight <= T0 + 1 && r.toHeight >= T0 + 1),
    `the run must cover the ingested height; got ${JSON.stringify(runs.map((r) => [r.fromHeight, r.toHeight]))}`
  );
});

test("a walked span of bitcoin blocks is covered end to end, with no holes", async () => {
  const store = seededStore();
  const heights = [T0, T0 + 1, T0 + 2, T0 + 3];
  const adapter = new BitcoinAdapter({ store, rpc: fakeRpc(heights), sha256: sha256Stub() });

  for (const n of heights) await adapter.ingestBlock(h(n));

  const runs = store.coverageFor("bitcoin");
  const covered = new Set<number>();
  for (const r of runs) for (let x = r.fromHeight; x <= r.toHeight; x++) covered.add(x);
  for (const n of heights) {
    ok(covered.has(n), `height ${n} was ingested but is not covered`);
  }
});

test("the header alone is not coverage", async () => {
  // The exact production shape: the block IS in the archive -- header stored,
  // reachable -- and yet unaccounted for. If a future refactor drops the
  // extendCoverage call again, headers will still be written and only this
  // assertion will notice.
  const store = seededStore();
  const adapter = new BitcoinAdapter({ store, rpc: fakeRpc([T0, T0 + 1]), sha256: sha256Stub() });

  await adapter.ingestBlock(h(T0 + 1));

  const headers = store.headersAtHeight("bitcoin", T0 + 1);
  ok(headers.length > 0, "precondition: the header was stored");
  eq(store.coverageFor("bitcoin").length > 0, true, "a stored header without a run is an unaccounted block");
});

test("coverage is only claimed for blocks actually ingested", async () => {
  // The inverse guard: recording a run for a block we never walked would be
  // worse than recording none. Skip T0+2 and it must NOT appear as covered.
  const store = seededStore();
  const adapter = new BitcoinAdapter({ store, rpc: fakeRpc([T0, T0 + 1, T0 + 2, T0 + 3]), sha256: sha256Stub() });

  await adapter.ingestBlock(h(T0 + 1));
  await adapter.ingestBlock(h(T0 + 3));

  const runs = store.coverageFor("bitcoin");
  const covered = new Set<number>();
  for (const r of runs) for (let x = r.fromHeight; x <= r.toHeight; x++) covered.add(x);
  eq(covered.has(T0 + 2), false, "a block that was never ingested must not be reported as covered");

  // And the hole must be visible to the completeness check.
  const report = assertCoverage(store, "bitcoin");
  eq(report.ok, false, "a gap must keep the chain from reporting ok coverage");
});

/**
 * THE CURSOR MUST ADVANCE.
 *
 * This adapter never called putCursor -- not once -- while the EVM adapter
 * does it after every head. So Bitcoin ingested blocks, stored headers and
 * recorded coverage while its cursor stayed frozen at the value written when
 * the hose first locked on. Measured live 2026-09-09:
 *
 *   runCount 7, covering blocks 966153..966159
 *   tipHeight / finalizedHeight / backfillTail all 966081
 *
 * The archive held blocks ABOVE its own recorded tip. Nothing crashed, and
 * coverage was climbing, so it read as a healthy chain. And because the
 * backfill reads backfillTail, a frozen cursor also pinned the past walk at
 * 198,651 blocks from protocol_t0 however well that walk worked.
 */
test("walking the tip advances the cursor", async () => {
  const store = seededStore();
  const before = store.getCursor("bitcoin")!;
  const adapter = new BitcoinAdapter({
    store,
    rpc: fakeRpc([T0, T0 + 1, T0 + 2, T0 + 3]),
    sha256: sha256Stub(),
  });

  await adapter.onWake(null);

  const after = store.getCursor("bitcoin")!;
  ok(after.tipHeight > before.tipHeight, `the tip must move; ${before.tipHeight} -> ${after.tipHeight}`);
  ok(
    store.getHeader("bitcoin", after.tipHash) !== undefined,
    "the cursor must point at a header the archive actually holds"
  );
});

test("the archive never claims a tip above the blocks it holds", async () => {
  // The exact production inconsistency, as an invariant: coverage recorded
  // blocks 966153..966159 while the cursor said 966081.
  const store = seededStore();
  const adapter = new BitcoinAdapter({
    store,
    rpc: fakeRpc([T0, T0 + 1, T0 + 2, T0 + 3]),
    sha256: sha256Stub(),
  });

  await adapter.onWake(null);

  const cursor = store.getCursor("bitcoin")!;
  const runs = store.coverageFor("bitcoin");
  const highestCovered = Math.max(...runs.map((r) => r.toHeight));
  ok(
    cursor.tipHeight >= highestCovered,
    `the cursor (${cursor.tipHeight}) must not lag the coverage it recorded (${highestCovered})`
  );
});

test("finalized trails the tip by the confirmation depth", async () => {
  const store = seededStore();
  const heights = [T0, T0 + 1, T0 + 2, T0 + 3, T0 + 4, T0 + 5, T0 + 6, T0 + 7, T0 + 8];
  const adapter = new BitcoinAdapter({ store, rpc: fakeRpc(heights), sha256: sha256Stub() });

  await adapter.onWake(null);

  const cursor = store.getCursor("bitcoin")!;
  ok(
    cursor.finalizedHeight <= cursor.tipHeight,
    "finalized may never exceed the tip"
  );
  ok(
    cursor.finalizedHeight >= cursor.t0Height,
    "and may never fall below the block the hose locked at"
  );
});

test("liveness is earned by hole-free coverage, and only then", async () => {
  // My first version of this test asserted streamAlive stays false and it
  // FAILED -- correctly. The fixture locks t0 at T0 and walks T0..T0+2, so
  // the run really is hole-free from t0 to finalized and liveness is earned.
  // The assertion was the wrong premise, not the code.
  //
  // What must actually hold is that the flag tracks assertCoverage rather
  // than being asserted by the adapter: hole-free earns it, a gap denies it.
  const contiguous = seededStore();
  const walked = new BitcoinAdapter({
    store: contiguous,
    rpc: fakeRpc([T0, T0 + 1, T0 + 2]),
    sha256: sha256Stub(),
  });
  await walked.onWake(null);
  eq(
    contiguous.getCursor("bitcoin")!.streamAlive,
    true,
    "a hole-free run from t0 to finalized earns the dot"
  );

  // Now the same walk with a block missing in the middle. A green dot on a
  // tape with a hole is the exact lie the coverage view exists to prevent.
  const holed = seededStore();
  const adapter = new BitcoinAdapter({
    store: holed,
    rpc: fakeRpc([T0, T0 + 1, T0 + 2, T0 + 3]),
    sha256: sha256Stub(),
  });
  await adapter.ingestBlock(h(T0 + 1));
  await adapter.ingestBlock(h(T0 + 3)); // T0+2 deliberately skipped
  await adapter.onWake(null);
  const report = assertCoverage(holed, "bitcoin");
  if (!report.ok) {
    eq(
      holed.getCursor("bitcoin")!.streamAlive,
      false,
      "a tape with a hole must not report a live stream"
    );
  }
});
