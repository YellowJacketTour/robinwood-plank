import { test } from "node:test";
import { ok, equal as eq } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EPOCH_WINDOW } from "../src/hose/backfill.ts";

/**
 * The Bitcoin backfill's throughput, and the one property parallelism can
 * silently break.
 *
 * 198,651 blocks separate the lock height from protocol_t0. At the old 8
 * blocks per epoch, walked serially, that is 24,832 epochs and the caller's
 * own comment put it at "43 days". Measured live 2026-09-09, the vendors are
 * nowhere near that slow: mempool.space served 47 ms/block serial and
 * 3.6 ms/block effective at 32-way, all requests succeeding. The 43 days was
 * a constant and a serial loop, not a vendor limit.
 */

const MAIN = readFileSync(new URL("../src/hose/main.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the bitcoin epoch window is no longer an arithmetic dead end", () => {
  const w = EPOCH_WINDOW.bitcoin!;
  const REMAINING = 198_651; // measured live: blocksToProtocolT0
  const epochs = Math.ceil(REMAINING / w);
  ok(w >= 32, `an epoch of ${w} blocks makes the walk longer than the data is useful for`);
  ok(
    epochs < 8_000,
    `${w} blocks/epoch still needs ${epochs} epochs; the old 8 needed ${Math.ceil(REMAINING / 8)}`,
  );
  // And bounded: a huge window turns a crash mid-epoch into a huge re-walk,
  // and the witness parse is real CPU per block.
  ok(w <= 256, `an epoch of ${w} blocks is too much work to lose to one crash`);
});

test("fetch is parallel but INGEST stays ordered", () => {
  // The property parallelism can silently break. Coverage must extend
  // contiguously and the hash-link is verified against what ingest actually
  // wrote, so ingesting out of order would corrupt the run-list while every
  // individual block was fetched correctly -- work done, bookkeeping wrong,
  // which is this archive's recurring failure shape.
  const at = MAIN.indexOf("FETCH IN PARALLEL, INGEST IN ORDER");
  ok(at > 0, "the bitcoin ingestRange must document the split");
  const body = MAIN.slice(at, MAIN.indexOf("return lowest;", at));

  const parallelFetch = body.indexOf("await Promise.all(");
  const orderedIngest = body.indexOf("await btc.ingestBlock(hash);");
  ok(parallelFetch > 0, "the height->hash lookups must be batched");
  ok(orderedIngest > 0, "the ingest must exist");
  ok(parallelFetch < orderedIngest, "fetch must complete before the ordered ingest begins");

  // The ingest loop must walk the ordered height list, never the hash map:
  // Map iteration order would follow completion order, not height order.
  ok(
    /for \(const h of heights\) \{/.test(body),
    "ingest must iterate the ordered heights array, not the fetch results",
  );
});

test("one failed height cannot discard the rest of the epoch", () => {
  const at = MAIN.indexOf("FETCH IN PARALLEL, INGEST IN ORDER");
  const body = MAIN.slice(at, MAIN.indexOf("return lowest;", at));
  // A rejected promise inside Promise.all discards the whole batch. Each
  // lookup must absorb its own failure -- a miss is a hole the gap worker
  // handles, not a reason to lose 63 good blocks.
  ok(/catch \{/.test(body), "each lookup must absorb its own failure");
  ok(!/Promise\.all\(\s*batch\.map\(\(h\) => rpc\.getBlockHashAtHeight\(h\)\)/.test(body),
    "an unguarded Promise.all would lose the whole batch to one bad height");
});

test("concurrency is bounded, not unlimited", () => {
  // This is a shared free endpoint. Racing it is how this archive earned a
  // 30-minute cooldown once already.
  const m = MAIN.match(/FETCH_CONCURRENCY = (\d+)/);
  ok(m, "the fan-out must be an explicit constant");
  const c = Number(m![1]);
  ok(c > 1, "serial defeats the purpose");
  ok(c <= 32, `${c}-way against a shared public host is not neighbourly`);
});
