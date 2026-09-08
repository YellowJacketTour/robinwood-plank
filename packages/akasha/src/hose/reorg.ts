import type { ArchiveStore } from "./store.ts";
import type { ChainId, Header } from "../shared/types.ts";
import type { Hex } from "../shared/hex.ts";

export interface RewindResult {
  common: Header | undefined;
  orphaned: Hex[];
  deletedEvents: number;
}

/**
 * Delete by block hash, never by height. Two blocks can share a height.
 */
export function rewindToCommonAncestor(
  store: ArchiveStore,
  chain: ChainId,
  newHead: Header,
  walkParent: (hash: Hex) => Header | undefined = (hash) => store.getHeader(chain, hash),
): RewindResult {
  const cursor = store.getCursor(chain);
  if (!cursor) throw new Error(`no cursor for ${chain}`);

  /**
   * The old tip's own ancestry, which is the ONLY thing a fork point can be
   * drawn from.
   *
   * Merely being present in the store does not make a header an ancestor: the
   * new branch's blocks are typically stored before the rewind runs, so a
   * presence check stops at the new head's own parent and reports a fork point
   * the old tip never descended from. Nothing is then deleted and the archive
   * silently keeps the orphaned branch.
   */
  const oldChain = new Map<string, Header>();
  {
    let t: Header | undefined = store.getHeader(chain, cursor.tipHash);
    while (t) {
      const key = t.hash.toLowerCase();
      if (oldChain.has(key)) break; // cycle or self-parent genesis
      oldChain.set(key, t);
      const parent: Header | undefined = store.getHeader(chain, t.parentHash);
      if (!parent || parent.hash.toLowerCase() === key) break;
      t = parent;
    }
  }

  const seenNew = new Set<string>();
  let n: Header | undefined = newHead;
  while (n) {
    seenNew.add(n.hash.toLowerCase());
    if (oldChain.has(n.hash.toLowerCase())) {
      // Everything on the old chain above the fork point is orphaned. This
      // walk is bounded because `oldChain` was built with its own cycle guard
      // -- a genesis header is its own parent, and an unguarded walk grows
      // `orphaned` until the process dies (`RangeError: Invalid array length`
      // after ~22s, observed).
      const orphaned: Hex[] = [];
      let t: Header | undefined = oldChain.get(cursor.tipHash.toLowerCase());
      while (t && t.hash.toLowerCase() !== n.hash.toLowerCase()) {
        orphaned.push(t.hash);
        t = oldChain.get(t.parentHash.toLowerCase());
      }
      const deletedEvents = store.deleteEventsByHashes(chain, orphaned);
      dropCoverageAtOrAbove(store, chain, n.height + 1);
      store.putCursor({
        ...cursor,
        tipHash: newHead.hash,
        tipHeight: newHead.height,
      });
      return { common: n, orphaned, deletedEvents };
    }
    n = walkParent(n.parentHash);
    if (n && seenNew.has(n.hash.toLowerCase())) break;
  }
  return { common: undefined, orphaned: [], deletedEvents: 0 };
}

function dropCoverageAtOrAbove(store: ArchiveStore, chain: ChainId, height: number): void {
  store.coverage = store.coverage.flatMap((r) => {
    if (r.chain !== chain) return [r];
    if (r.toHeight < height) return [r];
    if (r.fromHeight >= height) return [];
    return [{ ...r, toHeight: height - 1 }];
  });
}

export function isChildOfTip(store: ArchiveStore, chain: ChainId, header: Header): boolean {
  const c = store.getCursor(chain);
  return !!c && header.parentHash.toLowerCase() === c.tipHash.toLowerCase();
}
