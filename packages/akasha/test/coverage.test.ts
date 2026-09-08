/**
 * Coverage, venue isolation, and the address-scoped budget.
 *
 * Production's failure mode was a green "synced" dot computed from the last
 * event it happened to see. That is a liveness signal dressed as a
 * completeness one: a lane can look alive for hours while a hole sits behind
 * it. Here completeness is a single contiguous run [t0, finalized] and nothing
 * else is allowed to light the dot.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, ok, throws } from "./_expect.ts";
import { ArchiveStore } from "../src/hose/store.ts";
import { assertCoverage, canMarkStreamAlive, collapseRuns, holesIn } from "../src/hose/coverage.ts";
import { ingestOpenSeaStream, assertNoArtifactWrite } from "../src/hose/opensea.ts";
import { ADDRESS_SCOPED_FNS } from "../src/hose/adapters/evm.ts";
import type { ChainId, CoverageRun } from "../src/shared/types.ts";

const CHAIN: ChainId = "ethereum";

function run(from: number, to: number): CoverageRun {
  return {
    chain: CHAIN,
    fromHeight: from,
    toHeight: to,
    toHash: `0x${to.toString(16).padStart(4, "0")}` as `0x${string}`,
    eventCount: 0,
    artifactCount: 0,
    receiptDigest: "0x00" as `0x${string}`,
  };
}

function storeWith(runs: CoverageRun[], t0: number, finalized: number): ArchiveStore {
  const s = new ArchiveStore();
  s.putCursor({
    chain: CHAIN,
    t0Hash: "0x00" as `0x${string}`,
    t0Height: t0,
    tipHash: "0xff" as `0x${string}`,
    tipHeight: finalized + 5,
    finalizedHash: "0xfe" as `0x${string}`,
    finalizedHeight: finalized,
    streamAlive: false,
    streamKind: "ws_newheads",
  });
  for (const r of runs) s.putCoverage(r);
  return s;
}

test("a hole in [t0, finalized] means the stream is NOT alive", () => {
  // Blocks 100-200 and 260-400 indexed. 201-259 was never walked.
  const s = storeWith([run(100, 200), run(260, 400)], 100, 400);
  const report = assertCoverage(s, CHAIN);

  eq(report.ok, false, "a gap anywhere in the range is not completeness");
  eq(report.holes, [{ from: 201, to: 259 }], "the hole is reported exactly, not summarised");
  eq(canMarkStreamAlive(s, CHAIN), false, "the green dot must not light over a hole");
});

test("one contiguous run covering t0 to finalized IS alive", () => {
  const s = storeWith([run(100, 400)], 100, 400);
  eq(canMarkStreamAlive(s, CHAIN), true);
  eq(assertCoverage(s, CHAIN).holes, []);
});

test("adjacent runs collapse; a one-block gap does not", () => {
  eq(collapseRuns([run(1, 10), run(11, 20)]).length, 1, "11 continues 10");
  eq(collapseRuns([run(1, 10), run(12, 20)]).length, 2, "block 11 is missing");
});

test("holes at the head and tail of the range are found, not just the middle", () => {
  eq(holesIn([run(150, 400)], 100, 400), [{ from: 100, to: 149 }], "missing head");
  eq(holesIn([run(100, 350)], 100, 400), [{ from: 351, to: 400 }], "missing tail");
  eq(holesIn([], 100, 400), [{ from: 100, to: 400 }], "no runs at all is one big hole");
});

test("no cursor is not alive: unknown is never treated as complete", () => {
  const s = new ArchiveStore();
  const r = assertCoverage(s, CHAIN);
  eq(r.ok, false);
  eq(r.reason, "no cursor");
  eq(canMarkStreamAlive(s, CHAIN), false);
});

test("coverage is per chain: Solana's completeness cannot vouch for Ethereum's", () => {
  const s = storeWith([run(100, 400)], 100, 400);
  s.putCoverage({ ...run(1, 999_999), chain: "solana" as ChainId });
  eq(assertCoverage(s, CHAIN).ok, true);
  // And a fully covered Ethereum says nothing about a chain with no cursor.
  eq(canMarkStreamAlive(s, "solana" as ChainId), false);
});

// --- venue isolation -------------------------------------------------------

test("an unseen collection plus a listing yields ZERO artifacts", () => {
  const store = new ArchiveStore();
  const before = store.artifacts.size;

  const res = ingestOpenSeaStream({
    event_type: "item_listed",
    payload: {
      collection: { slug: "a-collection-we-have-never-indexed", address: "0xdeadbeef" },
      item: { nft_id: "ethereum/0xdeadbeef/1" },
      order_hash: "0xorder",
      protocol_data: { parameters: {}, signature: "0xsig" },
    },
  });

  eq(res.artifactsCreated, 0, "a venue may not conjure a collection into the archive");
  eq(store.artifacts.size, before, "and nothing reached the store");
  ok(res.ticket, "the signed order IS couriered: that part is verifiable later");
  eq(res.ticket!.kind, "COURIER_ORDER");
});

test("a stream event with no order is dropped entirely", () => {
  const res = ingestOpenSeaStream({
    event_type: "collection_offer",
    payload: { collection: { slug: "x" } },
  });
  eq(res.artifactsCreated, 0);
  eq(res.ticket, undefined, "an unsigned venue assertion is not evidence of anything");
});

test("the opensea module cannot reach the archive writer", () => {
  const src = () =>
    readFileSync(fileURLToPath(new URL("../src/hose/opensea.ts", import.meta.url)), "utf8");
  assertNoArtifactWrite(src);

  // The check must actually fail when the boundary is crossed, otherwise it is
  // a comment with a function signature.
  throws(
    () => assertNoArtifactWrite(() => 'import { ArchiveStore } from "./store.ts";'),
    /may never create an Artifact/
  );
  throws(() => assertNoArtifactWrite(() => "store.putArtifact(a)"), /archive writer/);
});

// --- address-scoped budget -------------------------------------------------

test("exactly two address-scoped call sites exist, and they are the named ones", () => {
  eq(ADDRESS_SCOPED_FNS.length, 2, "every address-scoped scan is a per-collection cost");
  eq([...ADDRESS_SCOPED_FNS].sort(), ["findEarliestTransferBlock", "runAddressScopedMembershipScan"]);

  // The pin is only worth anything if it matches the file. Count the real
  // exported functions that take an address, so adding a third fails here
  // rather than quietly multiplying provider spend across 250k collections.
  const src = readFileSync(
    fileURLToPath(new URL("../src/hose/adapters/evm.ts", import.meta.url)),
    "utf8"
  );
  const declared = [...src.matchAll(/export async function (\w+)\(\s*[^)]*?\baddress: string/gs)].map(
    (m) => m[1]
  );
  eq(declared.sort(), ["findEarliestTransferBlock", "runAddressScopedMembershipScan"],
    "a new address-scoped function must be justified, not merged silently");
});
