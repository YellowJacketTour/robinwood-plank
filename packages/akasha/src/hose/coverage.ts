import type { ArchiveStore } from "./store.ts";
import type { ChainId, CoverageRun } from "../shared/types.ts";

export interface CoverageReport {
  ok: boolean;
  chain: ChainId;
  expectedFrom: number;
  expectedTo: number;
  runs: CoverageRun[];
  holes: Array<{ from: number; to: number }>;
  reason?: string;
}

/**
 * Completeness is a single contiguous run [t0, finalized], not "last event we saw".
 */
export function collapseRuns(runs: CoverageRun[]): CoverageRun[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => a.fromHeight - b.fromHeight);
  const out: CoverageRun[] = [];
  let cur = { ...sorted[0]! };
  for (const r of sorted.slice(1)) {
    if (r.fromHeight <= cur.toHeight + 1 && r.chain === cur.chain) {
      cur = {
        ...cur,
        toHeight: Math.max(cur.toHeight, r.toHeight),
        toHash: r.toHeight >= cur.toHeight ? r.toHash : cur.toHash,
        eventCount: cur.eventCount + r.eventCount,
        artifactCount: cur.artifactCount + r.artifactCount,
        receiptDigest: r.receiptDigest,
      };
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  out.push(cur);
  return out;
}

/**
 * Collapse runs, but REFUSE to merge a seam whose hashes disagree.
 *
 * `collapseRuns` merges any two runs that touch. That is correct for a serial
 * walker, where every adjacency was produced by following parentHash and is
 * verified by construction. It is NOT correct once shards are walked
 * independently: two shards can be numerically adjacent and belong to
 * different chains -- a fork, a reorg one worker saw and another did not, or
 * an RPC that lied to exactly one of them.
 *
 * Merging such a pair would manufacture a contiguous run from two histories
 * and hand `complete_from_protocol` a single span it must not have. The
 * archive would report completeness over a seam nobody checked.
 *
 * So the seam is checked against what the archive actually HOLDS: the block at
 * the upper run's low edge must name the lower run's high block as its parent.
 * This is the same rule the serial backfill applies at its tail, applied at
 * every seam -- and it is strictly stronger, because the two sides were
 * fetched independently and must now agree.
 *
 * An unverified seam is not an error: the two runs simply stay separate, which
 * `holesIn` already renders as the boundary it is. The archive says "I have
 * these two spans and cannot prove they join", which is the honest answer.
 */
export function collapseVerifiedRuns(
  runs: CoverageRun[],
  parentHashAt: (chain: ChainId, height: number) => string | undefined,
): CoverageRun[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => a.fromHeight - b.fromHeight);
  const out: CoverageRun[] = [];
  let cur = { ...sorted[0]! };
  for (const r of sorted.slice(1)) {
    const touches = r.fromHeight <= cur.toHeight + 1 && r.chain === cur.chain;
    // An OVERLAP is self-consistent by construction (the same blocks, walked
    // twice) and needs no seam proof. Only a true adjacency -- where two
    // independently walked spans meet at a boundary neither verified -- does.
    const isAdjacency = touches && r.fromHeight === cur.toHeight + 1;
    const linked =
      !isAdjacency ||
      (() => {
        const parent = parentHashAt(r.chain, r.fromHeight);
        return (
          parent !== undefined && parent.toLowerCase() === cur.toHash.toLowerCase()
        );
      })();
    if (touches && linked) {
      cur = {
        ...cur,
        toHeight: Math.max(cur.toHeight, r.toHeight),
        toHash: r.toHeight >= cur.toHeight ? r.toHash : cur.toHash,
        eventCount: cur.eventCount + r.eventCount,
        artifactCount: cur.artifactCount + r.artifactCount,
        receiptDigest: r.receiptDigest,
      };
    } else {
      out.push(cur);
      cur = { ...r };
    }
  }
  out.push(cur);
  return out;
}

export function holesIn(runs: CoverageRun[], from: number, to: number): Array<{ from: number; to: number }> {
  const collapsed = collapseRuns(runs).filter((r) => r.toHeight >= from && r.fromHeight <= to);
  const holes: Array<{ from: number; to: number }> = [];
  let cursor = from;
  for (const r of collapsed) {
    const start = Math.max(r.fromHeight, from);
    if (start > cursor) holes.push({ from: cursor, to: start - 1 });
    cursor = Math.max(cursor, r.toHeight + 1);
  }
  if (cursor <= to) holes.push({ from: cursor, to });
  return holes;
}

export function assertCoverage(store: ArchiveStore, chain: ChainId): CoverageReport {
  const cursor = store.getCursor(chain);
  if (!cursor) {
    return {
      ok: false,
      chain,
      expectedFrom: 0,
      expectedTo: 0,
      runs: [],
      holes: [],
      reason: "no cursor",
    };
  }
  const runs = store.coverageFor(chain);
  const holes = holesIn(runs, cursor.t0Height, cursor.finalizedHeight);
  return {
    ok: holes.length === 0 && cursor.finalizedHeight >= cursor.t0Height,
    chain,
    expectedFrom: cursor.t0Height,
    expectedTo: cursor.finalizedHeight,
    runs: collapseRuns(runs),
    holes,
    reason: holes.length ? `holes ${JSON.stringify(holes)}` : undefined,
  };
}

export function canMarkStreamAlive(store: ArchiveStore, chain: ChainId): boolean {
  return assertCoverage(store, chain).ok;
}

export function extendCoverage(
  store: ArchiveStore,
  chain: ChainId,
  height: number,
  hash: import("../shared/hex.ts").Hex,
): void {
  const events = store.eventsInBlock(chain, hash);
  store.putCoverage({
    chain,
    fromHeight: height,
    toHeight: height,
    toHash: hash,
    eventCount: events.length,
    artifactCount: 0,
    receiptDigest: store.digestRange(chain, height, height),
  });
}
