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

  const seenNew = new Set<string>();
  let n: Header | undefined = newHead;
  while (n) {
    seenNew.add(n.hash.toLowerCase());
    if (store.getHeader(chain, n.hash)) {
      const orphaned: Hex[] = [];
      let t: Header | undefined = store.getHeader(chain, cursor.tipHash);
      while (t && t.hash.toLowerCase() !== n.hash.toLowerCase()) {
        orphaned.push(t.hash);
        t = store.getHeader(chain, t.parentHash);
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
