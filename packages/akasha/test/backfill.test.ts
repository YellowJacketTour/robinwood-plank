/**
 * The past flush, and the pins that bound it.
 *
 * Two clocks, opposite directions, one tape. The hose owns the tip; this
 * worker owns the past. The failure modes these pin are the ones that make a
 * naive backfill useless or dishonest:
 *
 *   - protocol_t0 = 0 on an old chain: spend the host on pre-NFT history
 *   - one process walking both directions: a slow 2018 getLogs stalls the tip
 *   - marking a range covered because a vendor returned 200
 *   - moving the tail across a boundary that does not hash-link
 */
import { test } from "node:test";
import { eq, ok, throws } from "./_expect.ts";
import { PostgresArchiveStore, type SqlClient } from "../src/hose/pg-store.ts";
import {
  BackfillWorker,
  EPOCH_WINDOW,
  FAIRNESS_FLOOR,
  familyOf,
  needPast,
  pickChain,
} from "../src/hose/backfill.ts";
import {
  PROTOCOL_T0,
  assertPinnedForCutover,
  isCutoverReady,
  protocolT0,
} from "../src/shared/protocol-t0.ts";
import type { ChainId, Header } from "../src/shared/types.ts";

const hx = (s: string) => s as `0x${string}`;
const noopSql: SqlClient = { async query() { return { rows: [] }; } };

function storeAt(chain: ChainId, origin: number, finalized: number): PostgresArchiveStore {
  const s = new PostgresArchiveStore(noopSql);
  s.putCursor({
    chain,
    t0Hash: hx("0xaa"),
    t0Height: origin,
    tipHash: hx("0xbb"),
    tipHeight: finalized + 3,
    finalizedHash: hx("0xcc"),
    finalizedHeight: finalized,
    streamAlive: true,
    streamKind: "zmq",
  });
  s.setProtocolT0(chain, protocolT0(chain));
  s.setBackfillTail(chain, origin + 1);
  s.setBackfillTail(chain, origin);
  return s;
}

// --- the pins --------------------------------------------------------------

test("Bitcoin's origin is inscription zero, not chain genesis", () => {
  eq(PROTOCOL_T0.bitcoin.height, 767_430);
  eq(PROTOCOL_T0.bitcoin.precision, "exact");
  ok(
    /inscription #0/.test(PROTOCOL_T0.bitcoin.because),
    "the number is load-bearing, so it must cite why",
  );
  // Taproot is a prerequisite, not the origin: nothing to parse before the
  // first envelope. Pinning at 709,632 would walk ~58k empty blocks.
  ok(PROTOCOL_T0.bitcoin.height > 709_632);
});

test("Ethereum's origin is the ERC-721 window, not block zero", () => {
  ok(PROTOCOL_T0.ethereum.height > 4_000_000, "block 0 would index years of pre-NFT history");
  eq(PROTOCOL_T0.ethereum.precision, "conservative", "erring EARLY is the safe direction");
});

test("every pin states its reasoning", () => {
  for (const [chain, pin] of Object.entries(PROTOCOL_T0)) {
    ok(pin.because.length > 20, `${chain}: a bare number nobody can defend`);
    ok(["exact", "conservative"].includes(pin.precision));
  }
});

test("an unpinned chain is REFUSED for cutover, loudly", () => {
  // Solana's pin is a placeholder: 0 means "walk every slot ever", which is
  // not a backfill plan. Cutting it over would produce a guess as a claim.
  eq(isCutoverReady("solana"), false);
  throws(() => assertPinnedForCutover("solana"), /no reviewed protocol_t0/);

  // And the chains that ARE pinned pass.
  for (const c of ["bitcoin", "ethereum", "base"] as ChainId[]) {
    eq(isCutoverReady(c), true);
    assertPinnedForCutover(c);
  }
});

// --- scheduling ------------------------------------------------------------

test("epoch windows are per family: one Bitcoin block is a whole witness parse", () => {
  eq(familyOf("bitcoin"), "bitcoin");
  eq(familyOf("solana"), "solana");
  eq(familyOf("base"), "evm");
  ok(EPOCH_WINDOW.bitcoin! < EPOCH_WINDOW.solana!);
  ok(EPOCH_WINDOW.solana! < EPOCH_WINDOW.evm!);
});

test("needPast is 1 at the origin lock and 0 once the tail reaches protocol_t0", () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  eq(needPast(s, "bitcoin", 900_000), 1, "nothing before the lock has been walked");
  eq(needPast(s, "bitcoin", protocolT0("bitcoin")), 0, "the past is closed");
  ok(needPast(s, "bitcoin", 850_000) < 1);
});

test("an unwatched chain still makes progress: the fairness floor", () => {
  const s = new PostgresArchiveStore(noopSql);
  for (const [chain, origin] of [["bitcoin", 900_000], ["ethereum", 20_000_000]] as const) {
    s.putCursor({
      chain,
      t0Hash: hx("0xaa"),
      t0Height: origin,
      tipHash: hx("0xbb"),
      tipHeight: origin,
      finalizedHash: hx("0xcc"),
      finalizedHeight: origin,
      streamAlive: true,
      streamKind: "http_tick",
    });
    s.setBackfillTail(chain, origin + 1);
    s.setBackfillTail(chain, origin);
  }

  // All gaze on Ethereum. Bitcoin must still be reachable, or a chain nobody
  // opens sits at its origin forever -- attention deciding existence, applied
  // to history.
  const gaze = (c: ChainId) => (c === "ethereum" ? 1 : 0);
  ok(FAIRNESS_FLOOR > 0, "a zero floor is attention deciding what exists");
  const picked = pickChain(s, ["bitcoin", "ethereum"], gaze);
  ok(picked === "ethereum" || picked === "bitcoin");
  // The floor is what makes bitcoin's score non-zero at all.
  eq(needPast(s, "bitcoin", s.getBackfillTail("bitcoin")!) * FAIRNESS_FLOOR > 0, true);
});

test("a chain whose past is closed is not picked again", () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  s.setBackfillTail("bitcoin", protocolT0("bitcoin"));
  eq(pickChain(s, ["bitcoin"]), undefined, "there is nothing left to walk");
});

// --- the hash link ---------------------------------------------------------

function hdr(chain: ChainId, height: number, hash: string, parent: string): Header {
  return { chain, height, hash: hx(hash), parentHash: hx(parent) };
}

test("a linked epoch moves the tail left", async () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  // The tail block, whose parent the epoch must produce.
  s.putHeader(hdr("bitcoin", 900_000, "0xtail", "0xparent"));

  const worker = new BackfillWorker({
    store: s,
    ingestRange: async (chain, from, to) => {
      const h = hdr(chain, to, "0xparent", "0xgrandparent");
      s.putHeader(h);
      return hdr(chain, from, "0xlowest", "0xbelow");
    },
  });

  const r = await worker.step(["bitcoin"]);
  ok(r);
  eq(r!.linked, true, "the epoch's top block IS the tail block's parent");
  eq(r!.tailMoved, true);
  ok(s.getBackfillTail("bitcoin")! < 900_000, "the tail walked left");
});

test("an UNLINKED epoch does not move the tail, and enqueues an audit", async () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  s.putHeader(hdr("bitcoin", 900_000, "0xtail", "0xparent"));
  const before = s.getBackfillTail("bitcoin");

  const worker = new BackfillWorker({
    store: s,
    ingestRange: async (chain, from, to) => {
      // Produces a block at the right HEIGHT whose hash is not the parent.
      s.putHeader(hdr(chain, to, "0ximposter", "0xwhatever"));
      return hdr(chain, from, "0xlowest", "0xbelow");
    },
  });

  const r = await worker.step(["bitcoin"]);
  ok(r);
  eq(r!.linked, false);
  eq(r!.tailMoved, false, "moving across an unverified boundary claims history we never read");
  eq(s.getBackfillTail("bitcoin"), before, "the tail stayed exactly where it was");
  const gap = s.gaps.find((g) => g.reason === "bloom_audit");
  ok(gap, "and the disputed range is queued for audit rather than forgotten");
});

test("an epoch that returns nothing does not move the tail either", async () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  const before = s.getBackfillTail("bitcoin");
  const worker = new BackfillWorker({ store: s, ingestRange: async () => undefined });

  const r = await worker.step(["bitcoin"]);
  eq(r!.tailMoved, false, "a vendor 200 with no blocks is not coverage");
  eq(s.getBackfillTail("bitcoin"), before);
});

test("the worker reports exhaustion instead of spinning", async () => {
  const s = storeAt("bitcoin", 900_000, 900_000);
  s.setBackfillTail("bitcoin", protocolT0("bitcoin"));
  const worker = new BackfillWorker({ store: s, ingestRange: async () => undefined });
  eq(await worker.step(["bitcoin"]), undefined, "every past is closed");
});

test("the Solana pin records the plausible-but-wrong route that was rejected", () => {
  // A programData account's slot LOOKS like a deploy slot and is trivially
  // readable, so the next person will find it. Measured 2026-09-08:
  // metaqbxx's programData decodes to slot 380,725,176, which is the LAST
  // UPGRADE -- about 300 days old against a tip of 445,466,896, while Solana
  // NFTs date from 2020. Pinning it would silently discard roughly six years
  // of history while reporting a confident completeness number.
  //
  // That is exactly the shape this program keeps refusing: a number that is
  // easy to obtain, looks authoritative, and is quietly wrong. Recording WHY
  // it was rejected is the only thing that stops it being "fixed" back in.
  const why = PROTOCOL_T0.solana.because;
  ok(/380,725,176/.test(why), "the rejected slot must be named, not just described");
  ok(/LAST UPGRADE/.test(why), "and why it is wrong");
  ok(
    /getSignaturesForAddress/.test(why),
    "the other exhausted route belongs here too, so it is not retried",
  );
  // And the pin itself must still refuse.
  eq(isCutoverReady("solana"), false);
  throws(() => assertPinnedForCutover("solana"), /no reviewed protocol_t0/);
});
