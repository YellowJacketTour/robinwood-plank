import { test } from "node:test";
import { ok, equal as eq, rejects } from "node:assert/strict";
import { Block, Transaction } from "bitcoinjs-lib";
import { EsploraBitcoinRpc } from "../src/hose/rpc/bitcoin.ts";
import { BitcoinAdapter, type BitcoinBlock } from "../src/hose/adapters/bitcoin.ts";
import { ArchiveStore } from "../src/hose/store.ts";

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
  for (let i = 0; i < 200; i++) eq(read!.tx[i].txid, block.transactions![i].getId());
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
