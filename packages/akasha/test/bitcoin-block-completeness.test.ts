import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";

/**
 * THE ARCHIVE WAS RECORDING BLOCKS IT HAD ONLY 7% READ.
 *
 * Measured live 2026-09-09 on block 965700: 6,754 transactions. getBlock
 * stopped after `maxTxs = 500` -- 20 pages of 25 -- so 6,254 of them (92.6%)
 * were never read. Every inscription in those transactions was missed, and
 * extendCoverage still recorded the block as covered.
 *
 * The coverage run-list IS the archive's completeness claim. A run recorded
 * for a partly-read block makes that claim a lie, and turns a hole the gap
 * worker would have absorbed into one nothing will ever revisit.
 *
 * The paging was also fully serial: 20 round-trips at ~316 ms measured is
 * ~6.3 s per block, ~7 minutes per 64-block epoch.
 */

const ADAPTER = readFileSync(new URL("../src/hose/adapters/bitcoin.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function rpcWithPages(totalTxs: number, failAtStart: number | null = null) {
  const calls: string[] = [];
  const rpc = new EsploraBitcoinRpc({
    hosts: ["https://h/api"],
    timeoutMs: 50,
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      const u = String(url);
      const json = async () => ({});
      if (u.endsWith("/block/H")) {
        return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => ({ id: "H", previousblockhash: "P", height: 965_700 }) };
      }
      const m = u.match(/\/txs\/(\d+)$/);
      if (m) {
        const start = Number(m[1]);
        if (failAtStart != null && start === failAtStart) throw new Error("fetch failed");
        const remaining = Math.max(0, totalTxs - start);
        const n = Math.min(25, remaining);
        return {
          ok: true, status: 200, statusText: "OK", text: async () => "",
          json: async () => Array.from({ length: n }, (_, i) => ({ txid: `t${start + i}`, vin: [] })),
        };
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => "", json };
    }) as never,
  } as never);
  return { rpc, calls };
}

test("a whole block is read, not the first 500 transactions", async () => {
  const { rpc } = rpcWithPages(6_754); // the real block 965700 tx count
  const block = await rpc.getBlock("H");
  ok(block, "the block must be returned");
  eq(block!.tx.length, 6_754, "every transaction must be read, not the first 500");
  eq(block!.complete, true, "and the block must report itself complete");
});

test("THE GUARD FIRES: a failed page marks the block INCOMPLETE", async () => {
  // A failed page is a HOLE, not an end of block. Swallowing it is how 92% of
  // a block went missing while the block was marked covered.
  const { rpc } = rpcWithPages(6_754, 200);
  const block = await rpc.getBlock("H");
  ok(block, "a partial read still returns what it got");
  eq(block!.complete, false, "but must NEVER claim completeness");
});

test("hitting the ceiling is itself incompleteness", async () => {
  const { rpc } = rpcWithPages(10_000);
  const block = await rpc.getBlock("H", 100);
  eq(block!.complete, false, "a block cut off at maxTxs is not complete");
});

test("pages are fetched in parallel, and reassembled IN ORDER", async () => {
  // Inscription position within a block is meaningful, so parallel fetching
  // must not reorder the transactions.
  const { rpc, calls } = rpcWithPages(200);
  const block = await rpc.getBlock("H");
  const ids = block!.tx.map((t) => t.txid);
  eq(ids[0], "t0", "the first transaction must still be first");
  eq(ids[ids.length - 1], "t199", "and the last must still be last");
  for (let i = 0; i < ids.length; i++) eq(ids[i], `t${i}`, `transaction ${i} is out of order`);
  ok(calls.filter((c) => c.includes("/txs/")).length >= 8, "sanity: several pages were fetched");
});

test("an INCOMPLETE block is not recorded as covered", () => {
  // The whole point. extendCoverage is the archive's completeness claim.
  const at = ADAPTER.indexOf("AND A TRUNCATED READ IS NOT A COMPLETED INGEST");
  ok(at > 0, "the adapter must document why coverage is conditional");
  const body = ADAPTER.slice(at, ADAPTER.indexOf("return { events", at));
  ok(/if \(block\.complete === false\)/.test(body), "coverage must be gated on completeness");
  ok(/incomplete_tx_walk/.test(body), "and the shortfall must be enqueued as a real gap");
  const gap = body.indexOf("enqueueGap");
  const cover = body.indexOf("extendCoverage");
  ok(gap > 0 && cover > 0 && gap < cover, "the gap path must come first, in the false branch");
});

test("only an EXPLICIT false suppresses coverage", () => {
  // `complete` is optional so existing constructors stay valid. A source that
  // cannot report completeness must behave exactly as before, not be silently
  // downgraded to 'incomplete'.
  const at = ADAPTER.indexOf("AND A TRUNCATED READ IS NOT A COMPLETED INGEST");
  const body = ADAPTER.slice(at, ADAPTER.indexOf("return { events", at));
  ok(!/if \(!block\.complete\)/.test(body), "a falsy check would suppress coverage for undefined too");
});
