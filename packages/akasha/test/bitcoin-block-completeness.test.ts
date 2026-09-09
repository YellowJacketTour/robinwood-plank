import { test } from "node:test";
import { ok, equal as eq, rejects } from "node:assert/strict";
import { Block, Transaction } from "bitcoinjs-lib";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";
import { BitcoinAdapter, type BitcoinBlock } from "../src/hose/adapters/bitcoin.ts";
import { ArchiveStore } from "../src/hose/store.ts";
import { readFileSync } from "node:fs";

// Preserve the upstream regression: block 965700 had 6,754 transactions,
// while the old pager read just 500. Raw verified bytes now replace paging.
function fixture(total: number, truncate = false) {
  const block = new Block(); block.prevHash = Buffer.alloc(32);
  block.transactions = Array.from({ length: total }, (_, i) => {
    const tx = new Transaction();
    tx.addInput(Buffer.alloc(32), 0xffffffff, undefined, Buffer.from([1, i & 255]));
    tx.addOutput(Buffer.from([0x51]), BigInt(i + 1)); return tx;
  });
  block.merkleRoot = Block.calculateMerkleRoot(block.transactions);
  const full = Buffer.from(block.toBuffer()); const calls: string[] = [];
  const rpc = new EsploraBitcoinRpc({ hosts: ["https://fixture.invalid"], fetchImpl: (async (url) => {
    calls.push(String(url));
    return String(url).endsWith("/raw") ? new Response(truncate ? full.subarray(0, full.length - 1) : full)
      : Response.json({ id: block.getId(), height: 965700 });
  }) as typeof fetch });
  return { rpc, block, calls };
}

test("all 6,754 transactions are read and marked complete", async () => {
  const { rpc, block } = fixture(6754);
  const read = await rpc.getBlock(block.getId());
  eq(read!.tx.length, 6754); eq(read!.complete, true);
});

test("a truncated raw response cannot claim coverage", async () => {
  const { rpc, block } = fixture(6754, true);
  const store = new ArchiveStore();
  const adapter = new BitcoinAdapter({ rpc, store, sha256: () => "0x00" });
  await rejects(adapter.ingestBlock(block.getId()));
  eq(store.coverageFor("bitcoin").length, 0);
});

test("one raw request preserves every transaction's original order", async () => {
  const { rpc, block, calls } = fixture(200);
  const read = await rpc.getBlock(block.getId());
  for (let i = 0; i < 200; i++) eq(read!.tx[i]!.txid, block.transactions![i]!.getId());
  eq(calls.filter(url => url.endsWith("/raw")).length, 1);
  eq(calls.filter(url => url.includes("/txs/")).length, 0);
});

for (const complete of [false, true, undefined]) test(`adapter coverage respects explicit completeness ${complete}`, async () => {
  const store = new ArchiveStore();
  const block: BitcoinBlock = { hash: "00".repeat(32), previousblockhash: null, height: 965700, complete, tx: [] };
  const adapter = new BitcoinAdapter({ store, sha256: () => "0x00", rpc: {
    getBlock: async () => block, getBlockHeader: async () => block,
    getBestBlockHash: async () => block.hash,
  } });
  const result = await adapter.ingestBlock(block.hash);
  eq(result.completed, complete !== false);
  eq(store.coverageFor("bitcoin").length, complete === false ? 0 : 1);
  if (complete === false) ok(store.gaps.some(gap => gap.reason === "incomplete_tx_walk"));
});

/**
 * The epoch walk must claim only what it can PROVE, contiguously.
 *
 * `heights` runs downward (to -> from). The loop used to `continue` past a
 * failed block, so a deeper block still became `lowest` -- and the caller
 * moves backfill_tail there, claiming a contiguous run across a hole it never
 * read. The archive's completeness predicate is a run-list; a tail advanced
 * over an unread block makes it wrong.
 */
const MAIN_SRC = readFileSync(new URL("../src/hose/main.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("the epoch walk STOPS at the first hole instead of skipping it", () => {
  const at = MAIN_SRC.indexOf("THE LOWEST CONTIGUOUS HEADER, NOT MERELY THE LOWEST ONE");
  ok(at > 0, "the contiguity rule must be documented where it is enforced");
  const body = MAIN_SRC.slice(at, MAIN_SRC.indexOf("return lowest;", at));

  ok(/if \(!hash\) break;/.test(body), "a missing hash must END the walk, not be skipped");
  ok(!/if \(!hash\) continue;/.test(body), "continuing past a hole is what claimed unread blocks");
  ok(/if \(!header\) break;/.test(body), "a block that did not persist must also end the walk");
});

test("the header is matched BY HASH, not by array position", () => {
  // `stored[stored.length - 1]` took the LAST header at that height, which at
  // a height with competing blocks can be a different block entirely -- and
  // the hash-link is then verified against the wrong record.
  const at = MAIN_SRC.indexOf("THE LOWEST CONTIGUOUS HEADER, NOT MERELY THE LOWEST ONE");
  const body = MAIN_SRC.slice(at, MAIN_SRC.indexOf("return lowest;", at));
  ok(
    /stored\.find\(\(x\) => x\.hash\.toLowerCase\(\) === hash\.toLowerCase\(\)\)/.test(body),
    "the persisted header must be located by hash",
  );
  ok(!/stored\[stored\.length - 1\]/.test(body), "array position is not identity");
});
