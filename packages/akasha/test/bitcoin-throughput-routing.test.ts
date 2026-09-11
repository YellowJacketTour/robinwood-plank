import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";

/**
 * A 1.6 MB block body and a 32-byte height lookup are not the same request,
 * and treating them the same is what makes Bitcoin's past take weeks.
 *
 * Measured live 2026-09-11, the SAME block from each host:
 *
 *   blockstream.info   1.52 MB in   982 ms = 1.54 MB/s
 *   mempool.space      1.52 MB in 5,741 ms = 0.26 MB/s
 *   mempool.ninja      1.52 MB in 5,743 ms = 0.26 MB/s
 *   mempool.va1        1.52 MB in 5,722 ms = 0.27 MB/s
 *   mempool.tk7        1.52 MB in 6,207 ms = 0.24 MB/s
 *
 * A six-fold spread. Pure rotation sends five of every six block fetches to
 * the slow side. The remaining past is ~191k blocks x ~1.6 MB = ~298 GB: at
 * 0.26 MB/s that is weeks, at 1.54 MB/s it is days.
 */

const FAST = "https://fast/api";
const SLOW = "https://slow/api";

/** A block body big enough to be measurable, served at a controlled rate. */
function rpcWithSpeeds(speeds: Record<string, number>) {
  const bulkCalls: string[] = [];
  const smallCalls: string[] = [];
  const BODY = 200_000;
  const rpc = new EsploraBitcoinRpc({
    hosts: [SLOW, FAST], // SLOW first, so ordering must be EARNED not incidental
    timeoutMs: 5_000,
    fetchImpl: (async (url: string) => {
      const u = String(url);
      const host = u.startsWith(FAST) ? FAST : SLOW;
      if (u.includes("/raw")) {
        bulkCalls.push(host);
        const ms = Math.round((BODY / speeds[host]!) * 1000);
        await new Promise((r) => setTimeout(r, Math.min(ms, 60)));
        return {
          ok: true, status: 200, statusText: "OK",
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(BODY),
          body: null,
          text: async () => "", json: async () => ({}),
        };
      }
      smallCalls.push(host);
      // getBlock() fetches the HEADER first and bails on null, so the header
      // must be well-formed or /raw is never reached at all. My first version
      // returned {} here and the bulk assertions saw zero calls.
      return {
        ok: true, status: 200, statusText: "OK",
        headers: { get: () => null },
        text: async () => "ab".repeat(32),
        json: async () => ({ id: "ab".repeat(32), previousblockhash: "cd".repeat(32), height: 900_000 }),
      };
    }) as never,
  } as never);
  return { rpc, bulkCalls, smallCalls };
}

test("throughput is recorded per host and exposed", async () => {
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const anyRpc = rpc as unknown as { recordThroughput(h: string, b: number, ms: number): void };
  anyRpc.recordThroughput(FAST, 1_600_000, 1_000);
  anyRpc.recordThroughput(SLOW, 1_600_000, 6_000);
  const seen = rpc.observedThroughput;
  ok(seen[FAST]! > seen[SLOW]!, "the faster host must record a higher rate");
  ok(seen[FAST]! > 1_000_000, `expected ~1.6 MB/s for the fast host, saw ${seen[FAST]}`);
});

test("THE POINT: the bulk order leads with the measured-fast host", () => {
  // Test the RULE directly. Driving it through getBlock() meant reasoning
  // about `rr` across two chained get() calls, and a mutation that removed the
  // ordering ENTIRELY kept passing because rotation happened to land the same
  // way. The rule is what the fix is; test the rule.
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const t = rpc as unknown as {
    hostThroughput: Map<string, number>;
    orderForRequest(live: string[], isBulk: boolean): string[];
  };
  t.hostThroughput.set(FAST, 1_600_000);
  t.hostThroughput.set(SLOW, 260_000);

  // SLOW is given first, so only the ordering can move FAST to the front.
  eq(t.orderForRequest([SLOW, FAST], true)[0], FAST, "a bulk read must lead with the fast host");
  eq(t.orderForRequest([FAST, SLOW], true)[0], FAST, "and must be stable regardless of input order");
});

test("a SMALL read keeps the caller's order untouched", () => {
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const t = rpc as unknown as {
    hostThroughput: Map<string, number>;
    orderForRequest(live: string[], isBulk: boolean): string[];
  };
  t.hostThroughput.set(FAST, 1_600_000);
  t.hostThroughput.set(SLOW, 260_000);
  eq(t.orderForRequest([SLOW, FAST], false)[0], SLOW, "rotation must survive for small reads");
});

test("an UNMEASURED host sorts ahead of a known-slow one", () => {
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const t = rpc as unknown as {
    hostThroughput: Map<string, number>;
    orderForRequest(live: string[], isBulk: boolean): string[];
  };
  t.hostThroughput.set(SLOW, 260_000); // FAST never sampled
  eq(
    t.orderForRequest([SLOW, FAST], true)[0],
    FAST,
    "a pool that never tries an unknown host can never learn it is the fast one",
  );
});

test("SMALL reads still ROTATE, so every provider's budget is respected", async () => {
  // Spreading small requests is what keeps a pool healthy. Only bulk bodies
  // are allowed to concentrate.
  const { rpc, smallCalls } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const anyRpc = rpc as unknown as { hostThroughput: Map<string, number> };
  anyRpc.hostThroughput.set(FAST, 1_600_000);
  anyRpc.hostThroughput.set(SLOW, 260_000);

  smallCalls.length = 0;
  for (let i = 0; i < 6; i++) await rpc.getBlockHashAtHeight(900_000 + i);
  const used = new Set(smallCalls);
  eq(used.size, 2, `height lookups must still spread across the pool, saw ${[...used].join(",")}`);
});

test("an UNMEASURED host is tried, or the pool can never learn", async () => {
  // Sorting unknown hosts last would mean a host that has never been sampled
  // is never sampled -- the fast host stays invisible forever.
  const { rpc, bulkCalls } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const anyRpc = rpc as unknown as { hostThroughput: Map<string, number> };
  anyRpc.hostThroughput.set(SLOW, 260_000); // only SLOW is known
  bulkCalls.length = 0;
  await rpc.getBlock(("0x" + "ab".repeat(32)) as never).catch(() => null);
  eq(bulkCalls[0], FAST, "an unmeasured host must be tried before a known-slow one");
});

test("a degrading host is DEMOTED within a few samples", async () => {
  // A host that was fast and becomes slow must not coast on an old reading.
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const anyRpc = rpc as unknown as {
    recordThroughput(h: string, b: number, ms: number): void;
    hostThroughput: Map<string, number>;
  };
  anyRpc.recordThroughput(FAST, 1_600_000, 1_000); // 1.6 MB/s
  for (let i = 0; i < 4; i++) anyRpc.recordThroughput(FAST, 1_600_000, 16_000); // 0.1 MB/s
  ok(
    anyRpc.hostThroughput.get(FAST)! < 400_000,
    `a degraded host must fall fast, saw ${anyRpc.hostThroughput.get(FAST)}`,
  );
});

test("a tiny response never pollutes the throughput estimate", async () => {
  // A 32-byte height reply divided by a millisecond is a meaningless rate, and
  // would make whichever host answered a small request look fastest.
  const { rpc } = rpcWithSpeeds({ [FAST]: 4_000_000, [SLOW]: 200_000 });
  const anyRpc = rpc as unknown as {
    recordThroughput(h: string, b: number, ms: number): void;
    hostThroughput: Map<string, number>;
  };
  anyRpc.recordThroughput(SLOW, 64, 1);
  eq(anyRpc.hostThroughput.get(SLOW), undefined, "a sub-threshold sample must be ignored");
});
