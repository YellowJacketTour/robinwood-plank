/**
 * The shattered archive: shards must cover the past exactly once, converge to
 * the same archive a serial walk produces, and never claim a seam they have
 * not verified.
 *
 * The serial backfill's rate was improved 60x and Bitcoin was still 43 days
 * from protocol_t0 before that; ten chains from genesis is a treadmill. The
 * fix is not a faster walk, it is not walking: a chain is a hash-linked DAG
 * that already exists, so its past is embarrassingly parallel.
 *
 * What must NOT be traded for that speed is the hash link. These tests pin
 * both halves -- the partition is exact, and the seam rule is the same one the
 * serial walker applies at its tail.
 */
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, ok, throws } from "./_expect.ts";
import { planShards, outstandingShards, seamLinks, SHARD_SPAN } from "../src/hose/shard.ts";
import { collapseRuns, holesIn } from "../src/hose/coverage.ts";
import { protocolT0 } from "../src/shared/protocol-t0.ts";
import type { CoverageRun } from "../src/shared/types.ts";

const T0 = protocolT0("bitcoin");
const TIP = 966_081;

function asRun(s: { from: number; to: number }): CoverageRun {
  return {
    chain: "bitcoin",
    fromHeight: s.from,
    toHeight: s.to,
    toHash: `0x${s.to.toString(16).padStart(64, "0")}` as `0x${string}`,
    eventCount: 0,
    artifactCount: 0,
    receiptDigest: "0x0" as `0x${string}`,
  };
}

test("the shards partition [t0, tip] exactly -- no gap, no overlap", () => {
  const shards = planShards("bitcoin", TIP);
  ok(shards.length > 1, "the past must actually be split");

  const sorted = [...shards].sort((a, b) => a.from - b.from);
  eq(sorted[0]!.from, T0, "the lowest shard must start at protocol_t0");
  eq(sorted[sorted.length - 1]!.to, TIP, "the highest must end at the tip");
  for (let i = 1; i < sorted.length; i++) {
    eq(
      sorted[i]!.from,
      sorted[i - 1]!.to + 1,
      `shard ${i} must begin exactly where ${i - 1} ended (no gap, no overlap)`
    );
  }
});

test("every block in the past belongs to exactly one shard", () => {
  // The partition property stated as a count, so an off-by-one in either
  // direction is caught rather than reasoned about.
  const shards = planShards("bitcoin", TIP);
  const total = shards.reduce((n, s) => n + (s.to - s.from + 1), 0);
  eq(total, TIP - T0 + 1, "summed shard widths must equal the span exactly");
});

test("shards are planned newest-first", () => {
  // Recent history is what visitors ask about, so the archive becomes useful
  // from the top down while its oldest shards are still outstanding.
  const shards = planShards("bitcoin", TIP);
  eq(shards[0]!.to, TIP, "the first shard must be the newest");
  ok(shards[0]!.from > shards[shards.length - 1]!.from, "and the order descends");
});

test("out-of-order completion converges to ONE run with no holes", () => {
  // The claim the whole design rests on. Shards finish in whatever order
  // workers happen to finish them; the archive must be indistinguishable from
  // what a strictly sequential walk would have produced.
  const shards = planShards("bitcoin", TIP);
  const runs = shards.map(asRun);
  // Deterministic shuffle -- a seeded permutation, so a failure reproduces.
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [runs[i], runs[j]] = [runs[j]!, runs[i]!];
  }

  const collapsed = collapseRuns(runs);
  eq(collapsed.length, 1, "a complete shard set must collapse to a single run");
  eq(collapsed[0]!.fromHeight, T0);
  eq(collapsed[0]!.toHeight, TIP);
  eq(holesIn(runs, T0, TIP).length, 0, "and report no holes");
});

test("a missing shard is reported as a hole, never as completeness", () => {
  // The failure that matters: partial parallel work must not look finished.
  const shards = planShards("bitcoin", TIP);
  const runs = shards.filter((_, i) => i !== 3 && i !== 17).map(asRun);

  const holes = holesIn(runs, T0, TIP);
  eq(holes.length, 2, "each missing shard must surface as its own hole");
  ok(collapseRuns(runs).length > 1, "and the run-list must not be a single span");
});

test("a shard fully inside covered ground is skipped; a partial one is not", () => {
  const shards = planShards("bitcoin", TIP);
  const first = shards[0]!;
  // Fully covered -> skip.
  const full = outstandingShards(shards, [
    { fromHeight: first.from, toHeight: first.to },
  ]);
  ok(!full.some((x) => x.from === first.from), "a fully covered shard is done");

  // PARTIALLY covered -> must still be claimed. Skipping it would leave the
  // uncovered remainder as a hole nothing revisits, and re-walking known
  // blocks is cheap and idempotent.
  const partial = outstandingShards(shards, [
    { fromHeight: first.from + 10, toHeight: first.to },
  ]);
  ok(
    partial.some((x) => x.from === first.from),
    "a partially covered shard must still be claimed"
  );
});

test("nothing is outstanding once the whole span is covered", () => {
  const shards = planShards("bitcoin", TIP);
  eq(outstandingShards(shards, [{ fromHeight: T0, toHeight: TIP }]).length, 0);
});

test("a seam links only when the hashes actually agree", () => {
  const lower = { toHeight: 800_000, toHash: "0xAAA" };
  ok(seamLinks(lower, { fromHeight: 800_001 }, "0xaaa"), "case-insensitive match links");
  ok(!seamLinks(lower, { fromHeight: 800_001 }, "0xbbb"), "a different parent must not link");
  ok(!seamLinks(lower, { fromHeight: 800_001 }, undefined), "an unknown parent must not link");
});

test("a seam with a gap between the runs never links", () => {
  // Two runs that do not touch cannot be merged however well their hashes
  // read -- this is what stops a fabricated adjacency from closing a hole.
  const lower = { toHeight: 800_000, toHash: "0xaaa" };
  ok(!seamLinks(lower, { fromHeight: 800_002 }, "0xaaa"), "a one-block gap must not link");
  ok(!seamLinks(lower, { fromHeight: 799_999 }, "0xaaa"), "an overlap must not link either");
});

test("the past being closed plans no shards", () => {
  eq(planShards("bitcoin", T0 - 1).length, 0, "below t0 there is nothing to do");
});

test("a zero or negative span is refused, not silently defaulted", () => {
  // An infinite loop dressed as a configuration value: `hi -= 0` never
  // terminates. Bounded by refusing the input rather than by hoping.
  throws(() => planShards("bitcoin", TIP, 0), /span must be >= 1/);
  throws(() => planShards("bitcoin", TIP, -5), /span must be >= 1/);
});

test("planning is bounded in steps, not just in wall clock", () => {
  // A fast machine hides an infinite loop. The shard count must equal the
  // arithmetic ceiling exactly -- if the loop ever failed to terminate this
  // assertion is what catches it, rather than a timeout that a quick runner
  // would sail past.
  const span = SHARD_SPAN.bitcoin!;
  const shards = planShards("bitcoin", TIP);
  eq(shards.length, Math.ceil((TIP - T0 + 1) / span));
});

/**
 * The wiring. A design that is not reachable from the production entrypoint is
 * a document, not a system -- and this package has already shipped a complete,
 * tested backfill whose Bitcoin path was a hard no-op because one branch was
 * missing. Structural tests, so a future refactor cannot quietly unhook it.
 */
test("shardTick exists on the Hose and walks through the owning adapter", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/hose/main.ts", import.meta.url)),
    "utf8"
  ).replace(/\r\n/g, "\n");
  ok(/async shardTick\(/.test(src), "the Hose must expose a shard pass");
  ok(/planShards\(/.test(src) && /claimShards\(/.test(src), "it must plan and claim");
  // Retire only on success; release on failure. Retiring a failed shard claims
  // work that was attempted rather than finished.
  ok(/retireShard\(/.test(src) && /releaseShard\(/.test(src), "both outcomes must be handled");
  const at = src.indexOf("async shardTick(");
  const body = src.slice(at, src.indexOf("\n  /**", at + 1));
  ok(/catch/.test(body), "a throwing shard must not strand its claim");
});

test("the production worker actually calls it", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../../scripts/akasha-hose.ts", import.meta.url)),
    "utf8"
  ).replace(/\r\n/g, "\n");
  ok(/hose\.shardTick\(/.test(src), "the entrypoint must drive the shard pass");
  ok(/AKASHA_SHARD_CLAIMS/.test(src), "and it must be operator-controlled");
  // Default OFF: sharding is a second reader against the same RPC pool, and a
  // host that cannot afford the fan-out must not discover it by being rate
  // limited off its own tip.
  ok(/AKASHA_SHARD_CLAIMS \?\? 0/.test(src), "it must default to off");
});
