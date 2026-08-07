import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_INDEX_GENESIS_BLOCK,
  CONFIRMATION_DEPTH_BLOCKS,
  confirmedHead,
  nativeFillPriceWei,
  planScan,
} from "../../lib/market/chain-indexer";
import {
  activityEventToRow,
  cursorKey,
  normalizeAddress,
  vaultEventToRow,
} from "../../lib/market/chain-events";
import type { ActivityEvent } from "../../lib/market/activity";
import type { VaultTradeEvent } from "../../lib/market/vault-activity";

const CHUNK = 50_000;
const MAX_CHUNKS = 12;

function plan(lastIndexedBlock: number | null, head: number, overrides = {}) {
  return planScan({
    lastIndexedBlock,
    head,
    genesisBlock: 1_000,
    confirmationDepth: 600,
    chunkBlocks: CHUNK,
    maxChunks: MAX_CHUNKS,
    ...overrides,
  });
}

/* ---------------- reorg confirmation depth ---------------- */

test("confirmedHead holds the ledger back by the confirmation depth", () => {
  assert.equal(confirmedHead(1_000_000, 600), 999_400);
  assert.equal(confirmedHead(1_000_000, 0), 1_000_000);
});

/**
 * A chain shallower than the depth must not produce a negative "safe" block
 * that a caller could mistake for a real block number. planScan reads the
 * negative as "nothing confirmed yet" and refuses to scan.
 */
test("confirmedHead on a chain shallower than the depth is negative, and scans nothing", () => {
  assert.ok(confirmedHead(10, 600) < 0);
  const p = plan(null, 10);
  assert.deepEqual(p.windows, []);
});

test("the default confirmation depth is a real, non-zero reorg buffer", () => {
  // 600 blocks ≈ one minute on this ~10 blocks/second L2 — see the constant's
  // own comment for why the generic "12 blocks" would be meaningless here.
  assert.ok(CONFIRMATION_DEPTH_BLOCKS > 0);
  assert.equal(CONFIRMATION_DEPTH_BLOCKS, 600);
});

/* ---------------- cursor advancement ---------------- */

test("first run ever starts at the genesis block, not at zero and not at the head", () => {
  const p = plan(null, 60_000);
  assert.equal(p.windows[0].fromBlock, 1_000);
  assert.equal(p.windows[0].toBlock, 50_999);
});

test("a resumed run starts at exactly cursor+1 — never re-scanning, never skipping", () => {
  const p = plan(40_000, 60_000);
  assert.equal(p.windows[0].fromBlock, 40_001);
  assert.equal(p.windows[0].toBlock, 59_400); // confirmed head, not raw head
  assert.equal(p.targetCursor, 59_400);
  assert.equal(p.caughtUp, true);
});

test("a cursor below genesis is pulled up to genesis rather than trusted", () => {
  const p = plan(5, 60_000);
  assert.equal(p.windows[0].fromBlock, 1_000);
});

test("nothing is due when every new block is still inside the confirmation depth", () => {
  // Cursor at 99,500; head 100,000 → confirmed head 99,400, which is BEHIND
  // the cursor. The correct answer is to do nothing and leave the cursor alone.
  const p = plan(99_500, 100_000);
  assert.deepEqual(p.windows, []);
  assert.equal(p.targetCursor, 99_500);
});

test("a caught-up cursor stays put across a tick with no new confirmed blocks", () => {
  const first = plan(null, 60_000);
  const second = plan(first.targetCursor, 60_000);
  assert.deepEqual(second.windows, []);
  assert.equal(second.targetCursor, first.targetCursor);
});

/* ---------------- backfill is bounded by the RPC budget ---------------- */

test("a cold backfill is bounded by logScanBudget, and resumes where it stopped", () => {
  const head = 10_000_000;
  const p = plan(null, head);
  assert.equal(p.windows.length, MAX_CHUNKS);
  assert.equal(p.caughtUp, false, "one tick cannot swallow 10M blocks");
  // Windows are contiguous and non-overlapping: no gap can hide in an
  // append-only ledger, and no block is paid for twice.
  for (let i = 1; i < p.windows.length; i += 1) {
    assert.equal(p.windows[i].fromBlock, p.windows[i - 1].toBlock + 1);
  }
  assert.equal(p.targetCursor, p.windows[p.windows.length - 1].toBlock);

  const next = plan(p.targetCursor, head);
  assert.equal(next.windows[0].fromBlock, p.targetCursor + 1);
});

test("windows never run past the confirmed head even mid-budget", () => {
  const p = plan(null, 80_000); // confirmed head 79,400 → 2 windows, second clipped
  assert.equal(p.windows.length, 2);
  assert.equal(p.windows[1].toBlock, 79_400);
  assert.equal(p.caughtUp, true);
});

test("the real genesis constant is the collection's deploy block, not zero", () => {
  // Scanning from 0 would burn ~17M blocks of empty windows on every cold
  // start. This is the RobinWood contract-creation block.
  assert.equal(CHAIN_INDEX_GENESIS_BLOCK, 17_048_370);
});

/* ---------------- row mapping / idempotency key ---------------- */

const SALE: ActivityEvent = {
  kind: "sale",
  tokenId: "42",
  from: "0xAAAAaaaAAAaaAAAAaAaaaaaAAAAaAAaaaaAAaAAA",
  to: "0xBBBBbbbBBBbbBBBBbBbbbbbBBBBbBBbbbbBBbBBB",
  priceWei: "110000000000000000",
  priceEth: "0.11",
  txHash: "0xDEAD".padEnd(66, "0"),
  blockNumber: 25_000_000,
  timestamp: "2026-08-01T00:00:00.000Z",
  imageUrl: null,
  venue: { kind: "seaport", contract: "0x0000000000000068F116a894984e2DB1123eB395" },
};

test("an activity event maps onto the (tx_hash, log_index) idempotency key", () => {
  const row = activityEventToRow(SALE, 7, "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156");
  assert.equal(row.logIndex, 7);
  assert.equal(row.txHash, SALE.txHash.toLowerCase());
  assert.equal(row.source, "nft");
  assert.equal(row.kind, "sale");
  assert.equal(row.priceWei, "110000000000000000");
  assert.equal(row.confirmed, true);
  // Addresses are lowercased so a checksummed value from one source and a
  // lowercase one from another can never become two rows for one wallet.
  assert.equal(row.fromAddress, SALE.from.toLowerCase());
  assert.equal(row.venueContract, SALE.venue!.contract.toLowerCase());
});

test("the same log mapped twice produces an identical key — the basis of re-runnability", () => {
  const a = activityEventToRow(SALE, 7, "0x327ceaaedbbCf55F40d6F1aBc71bd9bC8ADCb156");
  const b = activityEventToRow({ ...SALE }, 7, "0x327CEAAEDBBCF55F40D6F1ABC71BD9BC8ADCB156");
  assert.equal(`${a.txHash}:${a.logIndex}`, `${b.txHash}:${b.logIndex}`);
  assert.equal(a.contract, b.contract);
});

test("a zero or unreadable price stores as NULL, never as a misleading 0", () => {
  const free = activityEventToRow({ ...SALE, priceWei: "0" }, 1, SALE.venue!.contract);
  assert.equal(free.priceWei, null);
  const broken = activityEventToRow({ ...SALE, priceWei: "not-a-number" }, 1, SALE.venue!.contract);
  assert.equal(broken.priceWei, null);
});

test("a vault event keeps its own log index and its vault as the venue", () => {
  const event: VaultTradeEvent = {
    kind: "deposit",
    address: "0xCCCCccCCCCccCCCCcCccccccCCCCcCCccccCCcCC",
    ethWei: null,
    sharesWei: null,
    tokenId: "9",
    txHash: "0xBEEF".padEnd(66, "0"),
    blockNumber: 26_000_000,
    logIndex: 3,
    timestamp: null,
    vaultAddress: "0xacE28f72Fc3e15eA1671e689806694A9b0cE047D",
  };
  const row = vaultEventToRow(event, "0xacE28f72Fc3e15eA1671e689806694A9b0cE047D");
  assert.equal(row.source, "vault");
  assert.equal(row.logIndex, 3);
  assert.equal(row.venueKind, "vault");
  assert.equal(row.contract, event.vaultAddress!.toLowerCase());
  assert.equal(row.priceWei, null);
});

test("addresses that are not addresses are rejected rather than stored as junk", () => {
  assert.equal(normalizeAddress(""), null);
  assert.equal(normalizeAddress("marketplace"), null);
  assert.equal(normalizeAddress(null), null);
  assert.equal(
    normalizeAddress("0xACE28F72FC3E15EA1671E689806694A9B0CE047D"),
    "0xace28f72fc3e15ea1671e689806694a9b0ce047d"
  );
});

test("cursor keys are stable and case-insensitive per contract", () => {
  assert.equal(
    cursorKey("vault", "0xACE28F72FC3E15EA1671E689806694A9B0CE047D"),
    cursorKey("vault", "0xace28f72fc3e15ea1671e689806694a9b0ce047d")
  );
  assert.notEqual(cursorKey("nft", "0xabc"), cursorKey("vault", "0xabc"));
});

/* ---------------- native-fill price attribution ---------------- */

test("a single-token native fill keeps tx.value as its price", () => {
  assert.equal(
    nativeFillPriceWei({ kind: "sale", txValue: BigInt("33000000000000000"), tokensInTx: 1 }),
    BigInt("33000000000000000")
  );
});

test("a transaction's lump tx.value is never stamped onto each of several tokens", () => {
  // Real production case: 0x5174cfb4d8… moved 7 planks carrying 0.0007 ETH
  // total, and every one of the seven was stored as a 0.0007 ETH "sale".
  assert.equal(
    nativeFillPriceWei({ kind: "sale", txValue: BigInt("700000000000000"), tokensInTx: 7 }),
    null
  );
});

test("only sales get a native price at all", () => {
  assert.equal(
    nativeFillPriceWei({ kind: "transfer", txValue: BigInt("100000000000000"), tokensInTx: 1 }),
    null
  );
  assert.equal(
    nativeFillPriceWei({ kind: "mint", txValue: BigInt("100000000000000"), tokensInTx: 1 }),
    null
  );
});

test("no value moved means no price, never a misleading zero", () => {
  assert.equal(nativeFillPriceWei({ kind: "sale", txValue: BigInt(0), tokensInTx: 1 }), null);
  assert.equal(nativeFillPriceWei({ kind: "sale", txValue: null, tokensInTx: 1 }), null);
});
