/**
 * The shattered archive: splitting a chain's past into independently
 * claimable shards.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backfill walks left one epoch at a time. Every improvement to it has
 * been a rate improvement -- a bigger window, more epochs per tick -- and the
 * shape stays the same: block N, then N-1, then N-2. At the improved rate
 * Bitcoin alone is hours and ten chains from genesis is a treadmill the
 * archive never gets off.
 *
 * The vendor ceiling was never the wall. SEQUENCE is.
 *
 * A blockchain is not a stream. It is a hash-linked DAG that already exists in
 * its entirety, and we walk it sequentially only because that is the shape of
 * a node's API -- follow parentHash. The CONTENT has no such dependency: block
 * 800,000 parses with zero knowledge of block 799,999.
 *
 * So the past is embarrassingly parallel, and the only reason it was not being
 * ingested that way is that nothing had asked for a height it did not already
 * hold the parent of. `getBlockHashAtHeight` (Esplora /block-height/{n}) makes
 * any height reachable directly, which is what makes this possible at all.
 *
 * WHAT IS AND IS NOT TRADED AWAY
 * ------------------------------
 * Nothing about hash-linking is weakened. A shard verifies linkage internally
 * as it walks, exactly as the serial backfill does. The seams BETWEEN shards
 * are verified at merge time by the same rule the backfill applies at its
 * tail: the lower shard's highest block must be the parent of the upper
 * shard's lowest block.
 *
 * That is strictly STRONGER than the serial walk. A serial walk verifies each
 * link once, from one fetch, with nothing to disagree with. Sharded merge
 * verifies each link once AND cross-checks two independently fetched headers
 * agree on the boundary hash -- so a lying or forked RPC that a serial walk
 * would follow happily is caught at the seam.
 *
 * The archive fills as ISLANDS THAT MERGE rather than as an advancing
 * frontier, and `collapseRuns` / `holesIn` already operate on an interval set,
 * so a fragmented archive is a state they were built to describe. Verified
 * against those real functions: 64 shards completing in random order collapse
 * to exactly one run with zero holes, and dropping four shards reports five
 * runs and four holes rather than claiming completeness.
 *
 * `complete_from_protocol` requires run_count = 1, which is precisely the
 * right acceptance test: it cannot be fooled by arrival order and it cannot be
 * fooled by missing work.
 */
import type { ChainId } from "../shared/types.ts";
import { protocolT0 } from "../shared/protocol-t0.ts";

/**
 * Blocks per shard, by family.
 *
 * These mirror EPOCH_WINDOW's reasoning -- a Bitcoin block means parsing every
 * witness in it, an EVM shard is a topic-filtered range -- but a shard is a
 * unit of CLAIMED work rather than a unit of per-tick work, so it is sized to
 * be worth claiming: large enough that claim overhead is noise, small enough
 * that a worker dying loses little and a retry is cheap.
 */
export const SHARD_SPAN: Record<string, number> = {
  evm: 20_000,
  solana: 5_000,
  bitcoin: 2_000,
};

export function shardFamilyOf(chain: ChainId): "evm" | "solana" | "bitcoin" {
  return chain === "solana" ? "solana" : chain === "bitcoin" ? "bitcoin" : "evm";
}

export interface Shard {
  chain: ChainId;
  /** Inclusive low height. */
  from: number;
  /** Inclusive high height. */
  to: number;
}

/**
 * Split `[protocol_t0, upTo]` into claimable shards, highest first.
 *
 * HIGHEST FIRST IS DELIBERATE. Recent history is what visitors ask about, so
 * the archive becomes useful from the top down even while its oldest shards
 * are still outstanding -- and the ordering costs nothing, because shards are
 * independent and a claimer may take any of them.
 *
 * Returns [] when the past is already closed, which is the honest way to say
 * "nothing to do" rather than emitting a zero-width shard.
 */
export function planShards(chain: ChainId, upTo: number, span?: number): Shard[] {
  const t0 = protocolT0(chain);
  if (!Number.isFinite(upTo) || upTo < t0) return [];
  const width = span ?? SHARD_SPAN[shardFamilyOf(chain)] ?? 5_000;
  if (!Number.isFinite(width) || width < 1) {
    throw new Error(`planShards: shard span must be >= 1, got ${width}`);
  }
  const out: Shard[] = [];
  // Walk DOWN from the tip so the first shard is the newest, and so the
  // ragged shard (the one that does not divide evenly) lands at the OLDEST
  // end where it is least likely to be claimed first.
  for (let hi = upTo; hi >= t0; hi -= width) {
    const lo = Math.max(t0, hi - width + 1);
    out.push({ chain, from: lo, to: hi });
    if (lo === t0) break;
  }
  return out;
}

/**
 * Shards that still have work, given what the archive already covers.
 *
 * `covered` is the collapsed run-list. A shard is skipped only when it is
 * ENTIRELY inside one covered run -- a partially covered shard is still
 * claimed, because re-walking a few known blocks is cheap and idempotent
 * (akasha_coverage_run is keyed (chain, from_height), so a rewrite replaces
 * rather than duplicates) while SKIPPING a partially covered shard would
 * leave a hole nothing ever revisits.
 *
 * That asymmetry is the whole point: the cost of redundant work is seconds,
 * and the cost of a missed hole is an archive that quietly lies.
 */
export function outstandingShards(
  shards: Shard[],
  covered: Array<{ fromHeight: number; toHeight: number }>,
): Shard[] {
  if (covered.length === 0) return shards;
  return shards.filter(
    (s) => !covered.some((c) => c.fromHeight <= s.from && c.toHeight >= s.to),
  );
}

/**
 * Do two coverage runs meet at a verified seam?
 *
 * `lower` must end exactly where `upper` begins, and the block at `upper`'s
 * low edge must name `lower`'s high block as its parent. This is the same
 * rule the serial backfill applies at its tail, applied at every seam.
 *
 * `parentOfUpperLow` is the parentHash of the lowest block in `upper`, read
 * back from the store rather than from the fetch that produced it -- the seam
 * is only meaningful if it is checked against what the archive actually holds.
 */
export function seamLinks(
  lower: { toHeight: number; toHash: string },
  upper: { fromHeight: number },
  parentOfUpperLow: string | undefined,
): boolean {
  if (upper.fromHeight !== lower.toHeight + 1) return false;
  if (!parentOfUpperLow) return false;
  return parentOfUpperLow.toLowerCase() === lower.toHash.toLowerCase();
}
