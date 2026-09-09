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
