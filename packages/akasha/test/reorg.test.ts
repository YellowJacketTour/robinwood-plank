/**
 * Reorg handling: the only code here that DELETES.
 *
 * Two properties matter. Deletion is by block hash, never by height, because
 * two blocks can share a height and a height-scoped delete would take the
 * survivor with the orphan. And a rewind must reopen the coverage it
 * invalidated, or the archive keeps a green completeness claim over blocks it
 * just threw away -- a lie that outlives the reorg.
 */
import { test } from "node:test";
import { eq, ok } from "./_expect.ts";
import { ArchiveStore } from "../src/hose/store.ts";
import { rewindToCommonAncestor, isChildOfTip } from "../src/hose/reorg.ts";
import { canMarkStreamAlive } from "../src/hose/coverage.ts";
import type { ChainEvent, ChainId, Header } from "../src/shared/types.ts";

const CHAIN: ChainId = "ethereum";
const hx = (s: string) => s as `0x${string}`;

function header(height: number, hash: string, parent: string): Header {
  return { chain: CHAIN, height, hash: hx(hash), parentHash: hx(parent) };
}

function event(height: number, blockHash: string, token: string): ChainEvent {
  return {
    chain: CHAIN,
    blockHash: hx(blockHash),
    height,
    loc: 0,
    txHash: hx(`0xtx${token}`),
    kind: "transfer721",
    contractOrProgram: "0xc",
    tokenOrInscription: token,
    fromAddr: "0x0",
    toAddr: "0xA",
    raw: {},
  };
}

/**
 * Chain: 0x00 <- 0xa1 <- 0xa2 <- 0xa3, tip 0xa3.
 * A competing 0xb2 also builds on 0xa1, so 0xa2 and 0xb2 share height 2.
 */
function forkedStore(): ArchiveStore {
  const s = new ArchiveStore();
  const chainHeaders = [
    header(0, "0x00", "0xpre"),
    header(1, "0xa1", "0x00"),
    header(2, "0xa2", "0xa1"),
    header(3, "0xa3", "0xa2"),
  ];
  for (const h of chainHeaders) s.putHeader(h);

  s.putEvent(event(1, "0xa1", "keep-1"));
  s.putEvent(event(2, "0xa2", "orphan-2"));
  s.putEvent(event(3, "0xa3", "orphan-3"));

  s.putCursor({
    chain: CHAIN,
    t0Hash: hx("0x00"),
    t0Height: 0,
    tipHash: hx("0xa3"),
    tipHeight: 3,
    finalizedHash: hx("0xa1"),
    finalizedHeight: 1,
    streamAlive: true,
    streamKind: "ws_newheads",
  });
  s.putCoverage({
    chain: CHAIN,
    fromHeight: 0,
    toHeight: 3,
    toHash: hx("0xa3"),
    eventCount: 3,
    artifactCount: 0,
    receiptDigest: hx("0x00"),
  });
  return s;
}

test("a reorg rewinds to the common ancestor and drops only the orphaned blocks", () => {
  const s = forkedStore();
  // New head 0xb3 builds on 0xb2, which builds on the still-canonical 0xa1.
  s.putHeader(header(2, "0xb2", "0xa1"));
  const newHead = header(3, "0xb3", "0xb2");
  s.putHeader(newHead);

  const r = rewindToCommonAncestor(s, CHAIN, newHead);

  eq(r.common?.hash, hx("0xa1"), "0xa1 is the last block both branches agree on");
  eq([...r.orphaned].sort(), [hx("0xa2"), hx("0xa3")], "only the abandoned branch is orphaned");
  eq(r.deletedEvents, 2);

  const tokens = s.events.map((e) => e.tokenOrInscription).sort();
  eq(tokens, ["keep-1"], "the event under the common ancestor survives");
  eq(s.getCursor(CHAIN)!.tipHash, hx("0xb3"), "the cursor follows the new head");
});

test("deletion is by hash: a same-height block on the surviving branch is untouched", () => {
  const s = forkedStore();
  // 0xb2 shares height 2 with the orphaned 0xa2 and carries its own event.
  s.putHeader(header(2, "0xb2", "0xa1"));
  s.putEvent(event(2, "0xb2", "sibling-at-same-height"));
  const newHead = header(3, "0xb3", "0xb2");
  s.putHeader(newHead);

  rewindToCommonAncestor(s, CHAIN, newHead);

  const tokens = s.events.map((e) => e.tokenOrInscription).sort();
  ok(tokens.includes("sibling-at-same-height"),
    "a height-scoped delete would have taken this block's events with the orphan's");
  ok(!tokens.includes("orphan-2"));
});

test("a rewind reopens coverage: the archive stops claiming blocks it discarded", () => {
  const s = forkedStore();
  eq(canMarkStreamAlive(s, CHAIN), true, "before the reorg, 0..3 is covered");

  s.putHeader(header(2, "0xb2", "0xa1"));
  const newHead = header(3, "0xb3", "0xb2");
  s.putHeader(newHead);
  rewindToCommonAncestor(s, CHAIN, newHead);

  const runs = s.coverageFor(CHAIN);
  eq(runs.length, 1);
  eq(runs[0]!.toHeight, 1, "coverage is truncated to the common ancestor");
  ok(
    !runs.some((r) => r.toHeight > 1),
    "no run may still claim a height whose block was just deleted"
  );
});

test("an unrelated head finds no ancestor and deletes nothing", () => {
  const s = forkedStore();
  const before = s.events.length;
  // A header whose parent we have never seen: not a reorg of our chain.
  const alien = header(9, "0xdead", "0xbeef");

  const r = rewindToCommonAncestor(s, CHAIN, alien, () => undefined);

  eq(r.common, undefined);
  eq(r.deletedEvents, 0, "an unrecognised branch must not trigger deletion");
  eq(s.events.length, before);
  eq(s.getCursor(CHAIN)!.tipHash, hx("0xa3"), "and the cursor does not move");
});

test("a cycle in the parent walk terminates instead of hanging", () => {
  const s = forkedStore();
  const a = header(9, "0xc1", "0xc2");
  const b = header(8, "0xc2", "0xc1"); // points back at a
  const walk = (h: `0x${string}`) =>
    h.toLowerCase() === "0xc1" ? a : h.toLowerCase() === "0xc2" ? b : undefined;

  const r = rewindToCommonAncestor(s, CHAIN, a, walk);
  eq(r.common, undefined, "a malformed parent chain is refused, not followed forever");
  eq(r.deletedEvents, 0);
});

test("isChildOfTip distinguishes an extension from a reorg", () => {
  const s = forkedStore();
  eq(isChildOfTip(s, CHAIN, header(4, "0xa4", "0xa3")), true, "extends the tip");
  eq(isChildOfTip(s, CHAIN, header(3, "0xb3", "0xb2")), false, "needs a rewind first");
});

test("a self-parent genesis terminates the walk instead of exhausting memory", () => {
  // A genesis block is its own parent on several chains. An unguarded walk
  // asks the store for the same hash forever: this exact shape crashed with
  // `RangeError: Invalid array length` after ~22 seconds.
  const s = new ArchiveStore();
  s.putHeader(header(0, "0x00", "0x00")); // self-parent
  s.putHeader(header(1, "0xa1", "0x00"));
  s.putEvent(event(1, "0xa1", "e1"));
  s.putCursor({
    chain: CHAIN,
    t0Hash: hx("0x00"),
    t0Height: 0,
    tipHash: hx("0xa1"),
    tipHeight: 1,
    finalizedHash: hx("0x00"),
    finalizedHeight: 0,
    streamAlive: true,
    streamKind: "ws_newheads",
  });

  // A competing block at height 1, also building on genesis.
  const newHead = header(1, "0xb1", "0x00");
  s.putHeader(newHead);

  const started = Date.now();
  const r = rewindToCommonAncestor(s, CHAIN, newHead);
  ok(Date.now() - started < 2_000, "must terminate promptly, not spin on genesis");

  eq(r.common?.hash, hx("0x00"), "genesis is the fork point");
  eq(r.orphaned, [hx("0xa1")]);
  eq(s.events.length, 0, "the orphaned block's event is gone");
});
