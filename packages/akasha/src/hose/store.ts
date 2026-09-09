import { digestCanonical } from "../shared/hash.ts";
import type { Hex } from "../shared/hex.ts";
import type {
  Artifact,
  ChainCursor,
  ChainEvent,
  ChainId,
  CoverageRun,
  Gap,
  Header,
} from "../shared/types.ts";

/**
 * In-memory store that matches the SQL schema.
 * Swap for Postgres by implementing the same interface; hose never cares.
 */
export class ArchiveStore {
  cursors = new Map<ChainId, ChainCursor>();
  headers = new Map<string, Header>(); // `${chain}:${hash}`
  headersByHeight = new Map<string, Header[]>(); // `${chain}:${height}`
  events: ChainEvent[] = [];
  artifacts = new Map<string, Artifact>();
  coverage: CoverageRun[] = [];
  gaps: Gap[] = [];
  /** Derived tables copy block_hash so rewind can delete them. */
  derivedByBlock = new Map<string, string[]>();

  headerKey(chain: ChainId, hash: string): string {
    return `${chain}:${hash.toLowerCase()}`;
  }

  getCursor(chain: ChainId): ChainCursor | undefined {
    return this.cursors.get(chain);
  }

  putCursor(c: ChainCursor): void {
    this.cursors.set(c.chain, { ...c });
  }

  putHeader(h: Header): void {
    this.headers.set(this.headerKey(h.chain, h.hash), h);
    const hk = `${h.chain}:${h.height}`;
    const arr = this.headersByHeight.get(hk) ?? [];
    // REPLACE, DO NOT SKIP.
    //
    // This was `if (!arr.some(x => x.hash === h.hash)) arr.push(h)`, so a
    // re-put of an EXISTING hash updated `headers` and left the by-height
    // array holding the OLD object. Every correction to a header was
    // therefore invisible to headersAtHeight -- which is precisely what the
    // backfill's hash-link check reads.
    //
    // The two maps disagreed silently, and a repair could report success
    // while the value the reader sees never changed. Found 2026-09-09 while
    // repairing a self-parented Bitcoin lock block: the repair ran, `headers`
    // updated, and the link check kept failing on the stale copy.
    const at = arr.findIndex((x) => x.hash === h.hash);
    if (at >= 0) arr[at] = h;
    else arr.push(h);
    this.headersByHeight.set(hk, arr);
  }

  getHeader(chain: ChainId, hash: string): Header | undefined {
    return this.headers.get(this.headerKey(chain, hash));
  }

  headersAtHeight(chain: ChainId, height: number): Header[] {
    return this.headersByHeight.get(`${chain}:${height}`) ?? [];
  }

  putEvent(e: ChainEvent): boolean {
    const exists = this.events.some(
      (x) =>
        x.chain === e.chain &&
        x.blockHash.toLowerCase() === e.blockHash.toLowerCase() &&
        x.loc === e.loc,
    );
    if (exists) return false;
    this.events.push(e);
    return true;
  }

  eventsInBlock(chain: ChainId, hash: string): ChainEvent[] {
    const h = hash.toLowerCase();
    return this.events.filter((e) => e.chain === chain && e.blockHash.toLowerCase() === h);
  }

  eventsInRange(chain: ChainId, from: number, to: number): ChainEvent[] {
    return this.events.filter((e) => e.chain === chain && e.height >= from && e.height <= to);
  }

  deleteEventsByHashes(chain: ChainId, hashes: string[]): number {
    const set = new Set(hashes.map((h) => h.toLowerCase()));
    const before = this.events.length;
    this.events = this.events.filter(
      (e) => !(e.chain === chain && set.has(e.blockHash.toLowerCase())),
    );
    for (const hash of set) this.derivedByBlock.delete(`${chain}:${hash}`);
    return before - this.events.length;
  }

  putArtifact(a: Artifact): void {
    this.artifacts.set(a.id, a);
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  enqueueGap(g: Omit<Gap, "enqueuedAt" | "attempts"> & Partial<Pick<Gap, "enqueuedAt" | "attempts">>): void {
    const overlap = this.gaps.find(
      (x) =>
        x.chain === g.chain &&
        !(g.toHeight < x.fromHeight || g.fromHeight > x.toHeight),
    );
    if (overlap) {
      overlap.fromHeight = Math.min(overlap.fromHeight, g.fromHeight);
      overlap.toHeight = Math.max(overlap.toHeight, g.toHeight);
      return;
    }
    this.gaps.push({
      enqueuedAt: g.enqueuedAt ?? Date.now(),
      attempts: g.attempts ?? 0,
      ...g,
    });
  }

  popGap(chain?: ChainId): Gap | undefined {
    const idx = this.gaps.findIndex((g) => (chain ? g.chain === chain : true));
    if (idx < 0) return undefined;
    const [g] = this.gaps.splice(idx, 1);
    return g;
  }

  putCoverage(run: CoverageRun): void {
    this.coverage = this.coverage.filter(
      (r) => !(r.chain === run.chain && r.fromHeight === run.fromHeight && r.toHeight === run.toHeight),
    );
    this.coverage.push(run);
    this.coverage.sort((a, b) => a.fromHeight - b.fromHeight);
  }

  coverageFor(chain: ChainId): CoverageRun[] {
    return this.coverage.filter((r) => r.chain === chain).sort((a, b) => a.fromHeight - b.fromHeight);
  }

  digestRange(chain: ChainId, from: number, to: number): Hex {
    const ev = this.eventsInRange(chain, from, to).map((e) => [
      e.blockHash,
      e.loc,
      e.kind,
      e.contractOrProgram,
      e.tokenOrInscription,
    ]);
    ev.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return digestCanonical(ev);
  }
}

export function artifactId(chain: ChainId, kind: Artifact["kind"], tokenOrContract: string): string {
  return `${chain}:${kind}:${tokenOrContract.toLowerCase()}`;
}
