/**
 * holders_at_block: a replay, not a cached count.
 *
 * A holder count in Redis is not evidence of anything. This program replays
 * transfers from genesis and returns the owner set, so a stranger with a
 * public node can recompute it and disagree with us if we are wrong.
 *
 * ORDERING IS THE WHOLE CORRECTNESS ARGUMENT
 * ------------------------------------------
 * Ownership is path-dependent: the LAST transfer wins. So events must be
 * ordered by (height, loc). An earlier draft rebuilt events with `height: 0`,
 * which collapses every block to the same key and leaves ordering to `loc`
 * alone -- meaning a token transferred in block 100 at loc 2 and re-transferred
 * in block 900 at loc 1 resolves to the WRONG owner. That is silently wrong
 * for exactly the tokens that trade most, so the comparator sorts on height
 * first and the input type makes height non-optional.
 */
import { registerProgram } from "./program.ts";

export interface TransferInput {
  height: number;
  loc: number;
  blockHash: string;
  contract: string;
  tokenId: string;
  from: string;
  to: string;
}

export interface HoldersOutput {
  uniqueOwners: number;
  supply: number;
  /** tokenId -> owner, sorted, so the output is comparable byte-for-byte. */
  owners: Array<[string, string]>;
}

const ZERO = /^0x0{40}$/i;

export function runHolders(inputs: TransferInput[]): HoldersOutput {
  const ordered = [...inputs].sort((a, b) => a.height - b.height || a.loc - b.loc);

  const owner = new Map<string, string>();
  for (const t of ordered) {
    if (ZERO.test(t.to)) {
      owner.delete(t.tokenId); // burn
      continue;
    }
    owner.set(t.tokenId, t.to.toLowerCase());
  }

  const holders = new Set(owner.values());
  const owners = [...owner.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { uniqueOwners: holders.size, supply: owner.size, owners };
}

registerProgram<TransferInput, HoldersOutput>("holders.v1", runHolders);

/**
 * Partial coverage is a DIFFERENT claim kind, not a footnote on the same one.
 *
 * If the tape does not reach genesis, the honest answer is
 * `holders_at_block_partial` with the covered ranges listed. Publishing a
 * complete-looking count from partial data is the failure this separation
 * prevents: a wrong holder count is worse than a missing one.
 */
export function holdersClaimKind(coversGenesis: boolean): "holders_at_block" | "holders_at_block_partial" {
  return coversGenesis ? "holders_at_block" : "holders_at_block_partial";
}
