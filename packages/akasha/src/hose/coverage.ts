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
