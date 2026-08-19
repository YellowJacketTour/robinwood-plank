import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { planSolanaBatches, SOLANA_MAX_TX_BYTES } from "../../lib/market/multichain/trading/solana-tx-batch";

// Pure-function tests for the Solana single-signature batch-sweep planner --
// no wallet, no RPC, no network: exactly the "real, testable pure-function
// concern" the task called out (how many items fit per transaction), using
// REAL @solana/web3.js TransactionInstruction objects (not hand-rolled
// stand-ins) so the byte-size math is exercised against the library's own
// shapes.

const FEE_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PROGRAM_ID = new PublicKey("hausS13jsjafwWwGqZTUQRmWyvyxn9EQpqMwV1PBBmk"); // Magic Eden Auction House program id (real, public)

function smallBuyInstruction(seed: number): TransactionInstruction {
  // A representative small buy_now-shaped instruction: a handful of
  // accounts + a short data buffer, in the same ballpark as a real Auction
  // House execute_sale instruction.
  const keys = Array.from({ length: 8 }, (_, i) => ({
    pubkey: new PublicKey(`${FEE_PAYER}`),
    isSigner: i === 0,
    isWritable: true,
  }));
  keys[0].pubkey = new PublicKey(FEE_PAYER);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.from([seed % 256, 1, 2, 3, 4, 5, 6, 7]),
  });
}

function oversizedInstruction(): TransactionInstruction {
  // Deliberately far larger than SOLANA_MAX_TX_BYTES on its own via a huge data buffer.
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [{ pubkey: new PublicKey(FEE_PAYER), isSigner: true, isWritable: true }],
    data: Buffer.alloc(2000, 7),
  });
}

function foreignSignerInstruction(): TransactionInstruction {
  const otherSigner = new PublicKey("3KMHzE4AYcEwbp3isTT3cV5rycH7XH8MjHAWrTKosBcS");
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(FEE_PAYER), isSigner: true, isWritable: true },
      { pubkey: otherSigner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([1, 2, 3]),
  });
}

test("planSolanaBatches groups several small listings into a single shared-blockhash batch", () => {
  const listings = Array.from({ length: 4 }, (_, i) => ({ key: `mint-${i}`, instructions: [smallBuyInstruction(i)] }));
  const plan = planSolanaBatches({ listings, feePayer: FEE_PAYER });
  assert.equal(plan.unbatchable.length, 0);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].keys, ["mint-0", "mint-1", "mint-2", "mint-3"]);
});

test("planSolanaBatches splits many small listings into the minimum number of batches once byte size would overflow", () => {
  // A smaller maxBytes than the real 1232 ceiling makes this deterministic
  // without depending on the exact byte count of a hand-built test
  // instruction matching production's -- the SAME splitting logic
  // (planSolanaBatches's greedy grouping) is exercised either way, and the
  // real-limit case is separately asserted in the "single shared-blockhash
  // batch" test above, which fits comfortably under the true 1232 bytes.
  const listings = Array.from({ length: 40 }, (_, i) => ({ key: `mint-${i}`, instructions: [smallBuyInstruction(i)] }));
  const plan = planSolanaBatches({ listings, feePayer: FEE_PAYER, maxBytes: 300 });
  assert.equal(plan.unbatchable.length, 0);
  assert.ok(plan.batches.length > 1, "40 listings should require more than one batch");
  assert.ok(plan.batches.length < 40, "batching should meaningfully reduce signature count vs fully sequential");
  const allKeys = plan.batches.flatMap((b) => b.keys);
  assert.deepEqual(allKeys.sort(), listings.map((l) => l.key).sort());
  // Fewer signatures than sequential is the entire point of batching.
  assert.ok(plan.batches.length <= listings.length / 2, `expected meaningful consolidation, got ${plan.batches.length} batches for ${listings.length} listings`);
});

test("planSolanaBatches reports a listing too large to fit alone as unbatchable rather than corrupting a batch", () => {
  const listings = [
    { key: "mint-huge", instructions: [oversizedInstruction()] },
    { key: "mint-small", instructions: [smallBuyInstruction(1)] },
  ];
  const plan = planSolanaBatches({ listings, feePayer: FEE_PAYER });
  assert.deepEqual(plan.unbatchable, ["mint-huge"]);
  assert.equal(plan.batches.length, 1);
  assert.deepEqual(plan.batches[0].keys, ["mint-small"]);
});

test("planSolanaBatches reports a listing requiring a foreign signer as unbatchable", () => {
  const listings = [
    { key: "mint-foreign-signer", instructions: [foreignSignerInstruction()] },
    { key: "mint-small", instructions: [smallBuyInstruction(1)] },
  ];
  const plan = planSolanaBatches({ listings, feePayer: FEE_PAYER });
  assert.deepEqual(plan.unbatchable, ["mint-foreign-signer"]);
  assert.deepEqual(plan.batches[0].keys, ["mint-small"]);
});

test("planSolanaBatches never leaves a listing out of both batches and unbatchable", () => {
  const listings = [
    { key: "a", instructions: [smallBuyInstruction(1)] },
    { key: "b", instructions: [oversizedInstruction()] },
    { key: "c", instructions: [foreignSignerInstruction()] },
    { key: "d", instructions: [smallBuyInstruction(2)] },
  ];
  const plan = planSolanaBatches({ listings, feePayer: FEE_PAYER });
  const accountedFor = new Set([...plan.batches.flatMap((b) => b.keys), ...plan.unbatchable]);
  assert.deepEqual([...accountedFor].sort(), ["a", "b", "c", "d"]);
});

test("SOLANA_MAX_TX_BYTES matches Solana's real documented transaction-size limit", () => {
  assert.equal(SOLANA_MAX_TX_BYTES, 1232);
});
