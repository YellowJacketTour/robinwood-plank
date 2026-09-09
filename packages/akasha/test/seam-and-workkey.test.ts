/**
 * Steps 3-5 of the shattered archive: the seam verifier, content-addressed
 * work keys, and attention as a scheduler.
 *
 * Sharding makes one chain's past fast. These three make it SAFE across many
 * chains, and aim it at what people are looking at:
 *
 *   3. two independently walked spans may not be merged on adjacency alone
 *   4. work is keyed by WHAT it is, so ten chains stop paying ten times
 *   5. attention reorders the queue and never mints a subject
 */
import { test } from "node:test";
import { eq, ok, throws } from "./_expect.ts";
import { collapseRuns, collapseVerifiedRuns, holesIn } from "../src/hose/coverage.ts";
import {
  alreadyDone,
  attentionMayCreateShard,
  prioritiseShards,
  workKey,
} from "../src/hose/workkey.ts";
import { planShards } from "../src/hose/shard.ts";
import type { ChainId, CoverageRun } from "../src/shared/types.ts";

const CHAIN: ChainId = "bitcoin";

function run(from: number, to: number, toHash: string): CoverageRun {
  return {
    chain: CHAIN,
    fromHeight: from,
    toHeight: to,
    toHash: toHash as `0x${string}`,
    eventCount: 0,
    artifactCount: 0,
    receiptDigest: "0x0" as `0x${string}`,
  };
}

// ---------------------------------------------------------------- step 3

test("a verified seam merges, exactly as the serial walker would", () => {
  const runs = [run(100, 199, "0xaa"), run(200, 299, "0xbb")];
  // The block at 200 names 0xaa as its parent: the two spans really do join.
  const merged = collapseVerifiedRuns(runs, (_c, h) => (h === 200 ? "0xaa" : undefined));
  eq(merged.length, 1, "a proven seam is a single span");
  eq(merged[0]!.fromHeight, 100);
  eq(merged[0]!.toHeight, 299);
});

test("an UNVERIFIED seam stays two runs -- a fork cannot be merged away", () => {
  // The failure sharding introduces and serial walking cannot: two spans that
  // are numerically adjacent but belong to different histories. One worker saw
  // a reorg the other did not, or an RPC lied to exactly one of them.
  const runs = [run(100, 199, "0xaa"), run(200, 299, "0xbb")];
  const merged = collapseVerifiedRuns(runs, (_c, h) => (h === 200 ? "0xDIFFERENT" : undefined));
  eq(merged.length, 2, "an unproven adjacency must not become one span");

  // And the boundary must be visible as what it is.
  ok(
    collapseRuns(runs).length === 1,
    "precondition: the unverified collapse WOULD have merged these"
  );
});

test("a seam with no known parent is refused, not assumed", () => {
  // Absence of evidence is not evidence. A store that cannot answer must not
  // be read as agreement.
  const runs = [run(100, 199, "0xaa"), run(200, 299, "0xbb")];
  eq(collapseVerifiedRuns(runs, () => undefined).length, 2);
});

test("verified merging never claims completeness a hole would deny", () => {
  // The whole reason the seam check exists: complete_from_protocol asks for
  // ONE run. A fabricated merge would hand it one.
  const runs = [run(100, 199, "0xaa"), run(200, 299, "0xbb")];
  const bad = collapseVerifiedRuns(runs, () => "0xWRONG");
  ok(bad.length > 1, "so run_count stays above 1 and completeness is refused");
  eq(holesIn(bad, 100, 299).length, 0, "though the range itself has no numeric gap");
});

test("overlapping runs need no seam proof", () => {
  // An overlap is the same blocks walked twice -- self-consistent by
  // construction. Demanding a parent proof there would refuse honest work.
  const runs = [run(100, 250, "0xaa"), run(200, 299, "0xbb")];
  eq(collapseVerifiedRuns(runs, () => undefined).length, 1, "overlaps merge without a seam");
});

test("case never decides a seam", () => {
  const runs = [run(100, 199, "0xAaBb"), run(200, 299, "0xcc")];
  eq(collapseVerifiedRuns(runs, () => "0xaAbB").length, 1);
});

// ---------------------------------------------------------------- step 4

test("content-addressed work is shared across every chain", () => {
  const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
  const onBase = workKey({ kind: "content", id: cid, chain: "base" });
  const onArb = workKey({ kind: "content", id: cid, chain: "arbitrum" });
  eq(onBase, onArb, "the same bytes are one unit of work, wherever they were referenced");
  ok(onBase !== null);
});

test("location-addressed work is NEVER shared", () => {
  // Two hosts may serve different bytes for the same path, and the same host
  // may serve different bytes tomorrow. A shared key here would silently merge
  // two different bodies -- the two-matching-hashes fallacy by another route.
  const url = "https://api.example.com/token/1";
  eq(workKey({ kind: "location", id: url, chain: "base" }), null);
  eq(workKey({ kind: "location", id: url, chain: "arbitrum" }), null);
});

test("a done CID is done everywhere; a done URL is done nowhere", () => {
  const cid = "bafyxyz";
  const seen = new Set([workKey({ kind: "content", id: cid, chain: "base" })!]);
  ok(
    alreadyDone({ kind: "content", id: cid, chain: "polygon" }, seen),
    "one fetch of self-authenticating bytes is canonical everywhere"
  );
  ok(
    !alreadyDone({ kind: "location", id: "https://x/1", chain: "base" }, seen),
    "a mutable source is never satisfied by another chain's fetch"
  );
});

test("an empty subject produces no key", () => {
  eq(workKey({ kind: "content", id: "  ", chain: "base" }), null);
});

// ---------------------------------------------------------------- step 5

test("attention raises a shard's priority", () => {
  const shards = planShards(CHAIN, 966_081).slice(0, 20);
  const watched = shards[15]!;
  const ordered = prioritiseShards(shards, (s) =>
    s === `${watched.chain}:${watched.from}` ? 1 : 0
  );
  eq(ordered[0]!.shard.from, watched.from, "the watched shard is claimed first");
});

test("unwatched history still gets claimed -- the floor is the point", () => {
  // A pure attention sort turns the archive into a cache of whatever is
  // popular, which is the opposite of an archive. Every shard keeps a recency
  // baseline and attention ADDS to it.
  //
  // My first version of this test asserted only that no shard was DROPPED and
  // that the newest came first -- and a mutation removing the recency floor
  // entirely still passed it, because with zero gaze every score was 0 and the
  // sort was stable, so input order alone satisfied the assertion. It was a
  // mirror, not a check. The floor has to be observed as a real, DISTINCT
  // ordering signal.
  const shards = planShards(CHAIN, 966_081).slice(0, 10);
  const ordered = prioritiseShards(shards, () => 0);
  eq(ordered.length, shards.length, "no shard is dropped for being unwatched");

  // Unwatched shards must not all collapse to the same score: without a floor
  // there is no reason to prefer any of them and the queue has no order.
  const scores = ordered.map((o) => o.score);
  ok(
    new Set(scores).size > 1,
    `unwatched shards must still be ordered by recency, saw ${new Set(scores).size} distinct score(s)`
  );
  ok(scores[0]! > scores[scores.length - 1]!, "and the ordering must actually descend");
  eq(ordered[0]!.shard.to, Math.max(...shards.map((s) => s.to)), "newest first");
});

test("a watched OLD shard outranks an unwatched new one, but the floor survives", () => {
  // Attention must be able to beat recency -- that is the whole beam -- while
  // an unwatched shard keeps a score strictly above zero so it is still queued
  // rather than parked behind every future gaze forever.
  const shards = planShards(CHAIN, 966_081).slice(0, 12);
  const oldest = shards[shards.length - 1]!;
  const ordered = prioritiseShards(shards, (s) =>
    s === `${oldest.chain}:${oldest.from}` ? 1 : 0
  );
  eq(ordered[0]!.shard.from, oldest.from, "attention outranks recency");
  const newestUnwatched = ordered.find((o) => o.shard.to === Math.max(...shards.map((x) => x.to)))!;
  ok(newestUnwatched.score > 0, "an unwatched shard keeps a real, non-zero score");
});

test("attention cannot outrank a shard out of existence", () => {
  const shards = planShards(CHAIN, 966_081).slice(0, 5);
  const ordered = prioritiseShards(shards, (s) => (s.endsWith(":0") ? 1 : 0));
  eq(
    new Set(ordered.map((o) => o.shard.from)).size,
    shards.length,
    "every shard survives prioritisation exactly once"
  );
});

test("attention may reprioritise a shard, never create one", () => {
  // The mirror of attentionMayCreateEdge. A gaze at a height no planner
  // produced is a request to archive something no chain named.
  throws(attentionMayCreateShard, /never create one/);
});

test("no gaze is cheap and total", () => {
  const shards = planShards(CHAIN, 966_081).slice(0, 8);
  const ordered = prioritiseShards(shards);
  eq(ordered.length, 8, "the common case -- nobody looking -- must cost nothing");
});
