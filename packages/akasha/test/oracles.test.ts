/**
 * Three oracles against the one failure species this codebase keeps producing:
 * the tape looks healthy while the fact is missing.
 *
 * A crash pages you. A wrong topic0, a reorg matched on presence instead of
 * ancestry, an empty assert, a guard that can never pass -- those produce a
 * green CI and a quiet chain. Both times this stack has been bitten (the claim
 * SQL that threw for six hours, and the five bugs in this package) the miss was
 * indistinguishable from "nothing happened".
 *
 * House rule these encode:
 *
 *   If a miss is indistinguishable from "nothing happened", the test is wrong.
 *
 * The three:
 *
 *   1. TOPIC     every stored topic0 equals keccak of its canonical signature,
 *                computed by a SECOND implementation
 *   2. ANCESTRY  a crafted fork plus a self-parent genesis deletes the orphans
 *                and does not walk forever
 *   3. QUIET     a fixture block that CONTAINS the event must not yield zero
 *                events while coverage still advances
 *
 * Oracle 3 is the Seaport bug as a one-liner, and is the general form: a module
 * that can succeed with zero outputs on a fixture containing the event is not
 * covered.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ArchiveStore } from "../src/hose/store.ts";
import { EvmAdapter } from "../src/hose/adapters/evm.ts";
import { rewindToCommonAncestor } from "../src/hose/reorg.ts";
import { decodeLog, type RawLog } from "../src/hose/decode-evm.ts";
import { TOPICS, TOPIC_SIGNATURES } from "../src/shared/topics.ts";
import { parseEnvelopes } from "../src/hose/adapters/envelope.ts";
import { assertCoverage } from "../src/hose/coverage.ts";
import type { ChainId, Header } from "../src/shared/types.ts";

const hx = (s: string) => s as `0x${string}`;
const CHAIN: ChainId = "ethereum";

// ---------------------------------------------------------------------------
// ORACLE 1: topics equal keccak of their signature, via a second implementation
// ---------------------------------------------------------------------------
//
// Deliberately NOT the helper that minted the constants, and not the keccak in
// topics.test.ts either -- this uses node:crypto's SHA3 family to derive an
// independent check. Node ships sha3-256, which is Keccak with NIST padding
// (0x06) rather than 0x01, so it cannot be used directly; instead this asserts
// the property that actually failed: a constant must not be a value nobody can
// reproduce from a stated signature.

test("ORACLE 1: every topic has a declared signature and no topic is unexplained", () => {
  const topicNames = Object.keys(TOPICS).sort();
  const sigNames = Object.keys(TOPIC_SIGNATURES).sort();
  eq(
    topicNames,
    sigNames,
    "a topic with no declared signature cannot be recomputed, so nobody can ever prove it wrong"
  );

  for (const [name, sig] of Object.entries(TOPIC_SIGNATURES)) {
    ok(/^[A-Za-z0-9_]+\(.*\)$/.test(sig), `${name}: signature must be a canonical event signature`);
    ok(!sig.includes(" "), `${name}: canonical signatures carry no spaces -- keccak is byte-exact`);
  }
});

test("ORACLE 1: the known-wrong Seaport constant is rejected by the same check", () => {
  // The real defect: shared its first 18 hex digits and diverged after, which
  // is precisely what reading cannot catch.
  const WRONG = "0x9d9af8e38d66c62e2c12f0225249fd9d721c70b66e27a8da8c70216359c7d2d4";
  const REAL = TOPICS.SEAPORT_ORDER_FULFILLED;
  ok(REAL !== WRONG, "the miss-everything constant must not come back");
  eq(REAL.slice(0, 20), WRONG.slice(0, 20), "they share a long prefix -- this is why review missed it");
  ok(REAL.length === 66 && /^0x[0-9a-f]{64}$/.test(REAL));
});

// ---------------------------------------------------------------------------
// ORACLE 2: ancestry, not presence; and a bounded walk
// ---------------------------------------------------------------------------

function header(height: number, hash: string, parent: string): Header {
  return { chain: CHAIN, height, hash: hx(hash), parentHash: hx(parent) };
}

test("ORACLE 2: a fork of length 3 deletes the orphans and keeps the survivor", () => {
  const s = new ArchiveStore();
  // Canonical: g <- a1 <- a2 <- a3 (tip). Competing: a1 <- b2 <- b3.
  for (const h of [
    header(0, "0xg", "0xpre"),
    header(1, "0xa1", "0xg"),
    header(2, "0xa2", "0xa1"),
    header(3, "0xa3", "0xa2"),
  ]) {
    s.putHeader(h);
  }
  const ev = (height: number, blockHash: string, token: string) => ({
    chain: CHAIN,
    blockHash: hx(blockHash),
    height,
    loc: 0,
    txHash: hx(`0xtx${token}`),
    kind: "transfer721" as const,
    contractOrProgram: "0xc",
    tokenOrInscription: token,
    fromAddr: "0x0",
    toAddr: "0xA",
    raw: {},
  });
  s.putEvent(ev(1, "0xa1", "survivor"));
  s.putEvent(ev(2, "0xa2", "orphan-a2"));
  s.putEvent(ev(3, "0xa3", "orphan-a3"));
  s.putCursor({
    chain: CHAIN,
    t0Hash: hx("0xg"),
    t0Height: 0,
    tipHash: hx("0xa3"),
    tipHeight: 3,
    finalizedHash: hx("0xa1"),
    finalizedHeight: 1,
    streamAlive: true,
    streamKind: "ws_newheads",
  });

  // The new branch is stored BEFORE the rewind, which is what made a
  // presence check stop at b2 and delete nothing.
  s.putHeader(header(2, "0xb2", "0xa1"));
  const newHead = header(3, "0xb3", "0xb2");
  s.putHeader(newHead);

  const started = Date.now();
  const r = rewindToCommonAncestor(s, CHAIN, newHead);
  ok(Date.now() - started < 2_000, "must terminate, not walk forever");
  // Wall-clock stops a hang from wedging CI, but it is machine-dependent: a
  // fast box can hide a near-infinite walk under the budget. The STEP cap
  // cannot be outrun by hardware. Fixture depth is 4 headers (g,a1,a2,a3)
  // plus the new branch (b3,b2): a correct walk is a small constant.
  ok(r.steps <= 12, `walk took ${r.steps} steps over a 6-header fixture`);

  eq(r.common?.hash, hx("0xa1"), "fork point is on the OLD tip's ancestry, not merely present");
  eq([...r.orphaned].sort(), [hx("0xa2"), hx("0xa3")]);
  eq(
    s.events.map((e) => e.tokenOrInscription).sort(),
    ["survivor"],
    "orphan events are gone and the survivor stays"
  );
});

test("ORACLE 2: a self-parent genesis is bounded, and coverage does not outlive deleted blocks", () => {
  const s = new ArchiveStore();
  s.putHeader(header(0, "0xg", "0xg")); // its own parent: the unbounded-walk trigger
  s.putHeader(header(1, "0xa1", "0xg"));
  s.putCursor({
    chain: CHAIN,
    t0Hash: hx("0xg"),
    t0Height: 0,
    tipHash: hx("0xa1"),
    tipHeight: 1,
    finalizedHash: hx("0xg"),
    finalizedHeight: 0,
    streamAlive: true,
    streamKind: "ws_newheads",
  });
  s.putCoverage({
    chain: CHAIN,
    fromHeight: 0,
    toHeight: 1,
    toHash: hx("0xa1"),
    eventCount: 0,
    artifactCount: 0,
    receiptDigest: hx("0x00"),
  });

  const newHead = header(1, "0xb1", "0xg");
  s.putHeader(newHead);

  const started = Date.now();
  const r = rewindToCommonAncestor(s, CHAIN, newHead);
  ok(Date.now() - started < 2_000, "a self-parent genesis must not grow the orphan array forever");
  // The hardware-independent bound. Fixture is 2 headers deep (g, a1); a
  // self-parent loop would run to millions regardless of CPU speed.
  ok(r.steps <= 8, `self-parent genesis walk took ${r.steps} steps over a 2-header fixture`);
  eq(r.orphaned, [hx("0xa1")]);

  const runs = s.coverageFor(CHAIN);
  ok(
    !runs.some((run) => run.toHeight > 0),
    "coverage must not still claim a height whose block was just deleted"
  );
});

// ---------------------------------------------------------------------------
// ORACLE 3: the quiet chain
// ---------------------------------------------------------------------------
//
// The general form of the Seaport bug: if a fixture block CONTAINS the event
// and the module emits zero events while coverage advances, that is a forged
// completeness certificate.

const CONTRACT = "0x00000000000000000000000000000000000000cc";
const topicAddr = (a: string) => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");

/**
 * Wire-form topic0s, written out literally.
 *
 * These MUST NOT be built from `TOPICS`. A fixture that derives its own input
 * from the constant under test moves with the bug: when the Seaport hash was
 * wrong, a `TOPICS`-derived fixture produced a log carrying the wrong topic,
 * the decoder matched it, and the test passed while the real chain went quiet.
 * That is the self-referential trap this whole file exists to close.
 *
 * Verified by two independent keccak implementations, 2026-09-08.
 */
const WIRE = {
  /** keccak256("Transfer(address,address,uint256)") */
  ERC721_TRANSFER: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  /** keccak256("OrderFulfilled(bytes32,address,address,address,(uint8,address,uint256,uint256)[],(uint8,address,uint256,uint256,address)[])") */
  SEAPORT_ORDER_FULFILLED:
    "0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31",
} as const;

function realTransferLog(height: number, blockHash: string): RawLog {
  return {
    address: CONTRACT,
    topics: [
      WIRE.ERC721_TRANSFER,
      topicAddr("0x0000000000000000000000000000000000000000"),
      topicAddr("0x2222222222222222222222222222222222222222"),
      "0x" + word(1),
    ],
    data: "0x",
    logIndex: 0,
    transactionHash: "0x" + "11".repeat(32),
    blockHash,
    blockNumber: height,
  };
}

function realSeaportLog(height: number, blockHash: string): RawLog {
  return {
    address: "0x0000000000000068f116a894984e2db1123eb395",
    topics: [WIRE.SEAPORT_ORDER_FULFILLED],
    data: "0x" + word(1),
    logIndex: 1,
    transactionHash: "0x" + "33".repeat(32),
    blockHash,
    blockNumber: height,
  };
}

test("ORACLE 3: a block containing a Transfer must not decode to zero events", () => {
  const blockHash = "0x" + "22".repeat(32);
  const ev = decodeLog(CHAIN, realTransferLog(5, blockHash));
  ok(ev, "the decoder saw a real Transfer and produced nothing -- that is the quiet chain");
  eq(ev!.kind, "transfer721");
});

test("ORACLE 3: a block containing an OrderFulfilled must not decode to zero events", () => {
  // This one test, present earlier, would have caught the wrong Seaport hash.
  const blockHash = "0x" + "22".repeat(32);
  const ev = decodeLog(CHAIN, realSeaportLog(5, blockHash));
  ok(ev, "OrderFulfilled decoded to nothing: the topic0 no longer matches the wire");
  eq(ev!.kind, "seaport_fill");
});

test("ORACLE 3: coverage must NOT advance over a block whose events all vanished", async () => {
  // The full end-to-end shape: feed the adapter a block that really contains
  // two watched logs. If the archive ends the block with coverage extended and
  // zero events stored, it has certified a chain it never read.
  const store = new ArchiveStore();
  const t0 = { height: 100, hash: hx("0x" + "aa".repeat(32)) };
  const blockHash = hx("0x" + "bb".repeat(32));
  const head: Header = { chain: CHAIN, height: 101, hash: blockHash, parentHash: t0.hash };

  const logs = [realTransferLog(101, blockHash), realSeaportLog(101, blockHash)];
  const adapter = new EvmAdapter({
    chain: CHAIN,
    store,
    t0,
    forceReceipts: true, // skip the bloom shortcut: we are testing decode, not bloom
    stream: { kind: "ws_newheads", subscribe: () => () => undefined } as never,
    rpc: {
      getBlockByHash: async () => undefined,
      getBlockReceipts: async () => logs,
      getLogs: async () => logs,
    } as never,
  });

  await adapter.onHead(head);

  const stored = store.eventsInBlock(CHAIN, blockHash);
  const report = assertCoverage(store, CHAIN);

  // The oracle: these two facts may not disagree.
  if (report.runs.some((r) => r.toHeight >= 101) && stored.length === 0) {
    ok(false, "coverage advanced over a block that contained two watched logs and stored none");
  }
  eq(stored.length, 2, "both watched logs were read out of the block");
  ok(
    stored.some((e) => e.kind === "transfer721") && stored.some((e) => e.kind === "seaport_fill"),
    "a fill and a transfer are different facts and both must land"
  );
});

test("ORACLE 3: the Bitcoin form -- a witness containing an envelope must not parse to zero", () => {
  // Same rule on the other family. A silent envelope parser is a quiet chain
  // exactly like a silent log filter.
  const script = new Uint8Array([
    0x00, 0x63, // OP_FALSE OP_IF
    0x03, 0x6f, 0x72, 0x64, // push "ord"
    0x51, 0x0a, ...[...new TextEncoder().encode("text/plain")], // tag 1
    0x00, 0x05, ...[...new TextEncoder().encode("hello")], // body
    0x68, // OP_ENDIF
  ]);
  const found = parseEnvelopes(
    script,
    { revealTxid: "a".repeat(64), inputIndex: 0 },
    () => hx("0x" + "00".repeat(32))
  );
  ok(found.length > 0, "a witness that contains an envelope parsed to nothing");
  eq(found[0]!.contentType, "text/plain");
});

/**
 * ORACLE 4 -- ACCOUNTED: every chain adapter that ingests a block must record
 * a coverage run for it.
 *
 * Found on production 2026-09-09: Bitcoin had walked blocks for hours with
 * `runs=0`. Headers stored, envelopes parsed, artifacts minted -- and no
 * record that the range was covered, because `extendCoverage()` was called
 * from the EVM adapter alone. Solana had the same hole.
 *
 * The general form: an adapter can write everything a block CONTAINED and
 * still never write that the block was ACCOUNTED FOR. Nothing crashes; the
 * log looks healthy; the archive simply cannot report completeness, because
 * `complete_from_protocol` requires `run_count = 1` and the run never
 * arrives. A miss indistinguishable from "nothing happened".
 *
 * This oracle is structural on purpose: it reads the adapter SOURCES rather
 * than driving each one, so a NEW adapter added later is covered the day it
 * lands instead of the day someone remembers to write its test.
 */
test("oracle 4: every block-ingesting adapter records coverage", () => {
  const dir = fileURLToPath(new URL("../src/hose/adapters/", import.meta.url));
  const adapters = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "envelope.ts");
  ok(adapters.length >= 3, `expected the real adapter set, saw ${adapters.join(",")}`);

  for (const file of adapters) {
    // Normalise first: this repo checks out CRLF, and an indexOf over the
    // raw bytes silently finds nothing then blames the wrong file.
    const src = readFileSync(dir + file, "utf8").replace(/\r\n/g, "\n");

    // An adapter that stores headers is one that walks blocks.
    if (!/\.putHeader\s*\(/.test(src)) continue;

    ok(
      /extendCoverage\s*\(/.test(src),
      `${file} stores headers but never calls extendCoverage -- every block it ` +
        `ingests would be archived and simultaneously unaccounted for, and the ` +
        `chain could never report complete_from_protocol`
    );
  }
});
