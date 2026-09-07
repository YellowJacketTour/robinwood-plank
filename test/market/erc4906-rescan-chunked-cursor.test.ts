import assert from "node:assert/strict";
import test from "node:test";
import {
  ERC4906_LOG_CHUNK_BLOCKS,
  planBlockChunks,
  scanMetadataUpdateLogsChunked,
  type MetadataUpdateLogEntry,
} from "../../lib/market/multichain/discovery/onchain-extensions";
import { clampBatchTokenRange, rotateBatch } from "../../lib/market/multichain/discovery/erc4906-rescan";

/**
 * AUDIT lens 4 #4 (Batch F4). Pure pieces of the ERC-4906 rescan lane:
 * chunk planning, fail-honest chunked walk, supply clamp, rotation.
 */

test("planBlockChunks: inclusive <= 2,000-block chunks, exact tail, empty on inverted range", () => {
  assert.equal(ERC4906_LOG_CHUNK_BLOCKS, 2_000);
  const chunks = planBlockChunks(1_000, 5_500);
  assert.deepEqual(chunks, [
    { fromBlock: 1_000, toBlock: 2_999 },
    { fromBlock: 3_000, toBlock: 4_999 },
    { fromBlock: 5_000, toBlock: 5_500 },
  ]);
  for (const c of chunks) assert.ok(c.toBlock - c.fromBlock + 1 <= 2_000);
  assert.deepEqual(planBlockChunks(10, 10), [{ fromBlock: 10, toBlock: 10 }]);
  assert.deepEqual(planBlockChunks(10, 9), []);
});

test("scanMetadataUpdateLogsChunked: stops at the first failing chunk and reports scannedThrough honestly", async () => {
  const calls: Array<[number, number]> = [];
  const entry = (blockNumber: number): MetadataUpdateLogEntry => ({ tokenId: String(blockNumber), fromTokenId: null, toTokenId: null, blockNumber });
  const result = await scanMetadataUpdateLogsChunked("eth-mainnet", "0x" + "ab".repeat(20), { fromBlock: 0, toBlock: 9_999, chunkSize: 2_000 }, {
    fetchRange: async (from, to) => {
      calls.push([from, to]);
      if (from === 4_000) throw new Error("query returned more than 10000 results");
      return [entry(from)];
    },
  });
  assert.deepEqual(calls, [[0, 1_999], [2_000, 3_999], [4_000, 5_999]]);
  assert.equal(result.chunksAttempted, 3);
  assert.equal(result.chunksSucceeded, 2);
  assert.equal(result.scannedThrough, 3_999, "cursor may advance only through the last proven chunk");
  assert.match(result.error ?? "", /more than 10000/);
  assert.deepEqual(result.entries.map((e) => e.blockNumber), [0, 2_000]);
});

test("scanMetadataUpdateLogsChunked: first chunk failing means scannedThrough null; maxChunks bounds one pass", async () => {
  const failed = await scanMetadataUpdateLogsChunked("eth-mainnet", "0x" + "ab".repeat(20), { fromBlock: 100, toBlock: 200 }, {
    fetchRange: async () => { throw new Error("rpc down"); },
  });
  assert.equal(failed.scannedThrough, null);
  assert.equal(failed.chunksSucceeded, 0);

  let n = 0;
  const bounded = await scanMetadataUpdateLogsChunked("eth-mainnet", "0x" + "ab".repeat(20), { fromBlock: 0, toBlock: 99_999, chunkSize: 2_000, maxChunks: 3 }, {
    fetchRange: async () => { n += 1; return []; },
  });
  assert.equal(n, 3);
  assert.equal(bounded.scannedThrough, 5_999);
  assert.equal(bounded.error, null);
});

test("clampBatchTokenRange: BatchMetadataUpdate(0, 2^256-1) is clamped to the known supply", () => {
  const uint256Max = (2n ** 256n - 1n).toString();
  assert.deepEqual(clampBatchTokenRange("0", uint256Max, 9_999n), { from: "0", to: "9999" });
  assert.deepEqual(clampBatchTokenRange("5", "10", 9_999n), { from: "5", to: "10" });
  assert.equal(clampBatchTokenRange("10000", uint256Max, 9_999n), null, "range entirely past supply is empty");
  assert.equal(clampBatchTokenRange("10", "5", 9_999n), null, "inverted range is empty");
  assert.equal(clampBatchTokenRange("0", uint256Max, null), null, "unknown supply never allows an unbounded BETWEEN");
  assert.deepEqual(clampBatchTokenRange("0", "100", null), { from: "0", to: "100" }, "unknown supply still allows a small explicit range");
  assert.equal(clampBatchTokenRange("0x1", "5", 10n), null, "non-decimal input is rejected");
});

test("rotateBatch: rotating cursor wraps to the head instead of pinning the same alphabetical five", () => {
  const all = ["0xa", "0xb", "0xc", "0xd", "0xe", "0xf", "0xg"];
  // cursor at 0xe: after = [0xf, 0xg], head = [0xa, 0xb, 0xc, 0xd, 0xe]
  const r = rotateBatch(all.slice(5), all.slice(0, 5), 5);
  assert.deepEqual(r.batch, ["0xf", "0xg", "0xa", "0xb", "0xc"]);
  assert.equal(r.wrapped, true);
  const full = rotateBatch(all.slice(0, 5), all.slice(0, 5), 5);
  assert.deepEqual(full.batch, all.slice(0, 5));
  assert.equal(full.wrapped, false);
  // Fewer collections than the limit: every one exactly once, no duplicates.
  const small = rotateBatch(["0xb"], ["0xa", "0xb"], 5);
  assert.deepEqual(small.batch, ["0xb", "0xa"]);
  // Empty chain: an empty batch is still a wrap (nothing to rotate), never a throw.
  assert.deepEqual(rotateBatch([], [], 5), { batch: [], wrapped: true });
});
