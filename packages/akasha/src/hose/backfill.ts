/**
 * The past flush: `backfill_tail` walking left toward `protocol_t0`.
 *
 * Two clocks, opposite directions, one tape. The hose owns the tip and moves
 * `finalized_head` right; this worker owns the past and moves `backfill_tail`
 * left. Neither touches the other's pin.
 *
 * WHY EPOCHS AND NOT ONE BIG WALK
 * -------------------------------
 * One host cannot drink eleven histories in a gulp. A window is small and
 * chain-specific, one epoch job in flight per chain, and the chain with the
 * greatest remaining past gets the next turn -- with a fairness floor so a
 * chain nobody is watching still makes progress, just slower.
 *
 * THE HASH-LINK RULE
 * ------------------
 * A new run may only extend the tail if its last block's hash chains to the
 * parent of the current tail block. If it does not link, the tail does NOT
 * move and a `bloom_audit` is enqueued instead. Moving a tail across an
 * unverified boundary is how an archive claims history it never read -- the
 * same failure as coverage advancing over a filter that matched nothing.
 */
import type { ArchiveStore } from "./store.ts";
import type { PostgresArchiveStore } from "./pg-store.ts";
import type { ChainId, Header } from "../shared/types.ts";
import { protocolT0 } from "../shared/protocol-t0.ts";

/**
 * Blocks per epoch, by family. Bitcoin is smaller than EVM because one block
 * means parsing every witness in it; EVM is a topic-only getLogs over a range.
 *
 * BITCOIN WAS 8, AND 8 IS AN ARITHMETIC DEAD END.
 * ----------------------------------------------
 * 198,651 blocks separate the lock height from protocol_t0. At 8 blocks per
 * epoch that is 24,832 epochs, and this file's own caller notes the result:
 * "at 8 blocks per epoch the default rate needed 43 days".
 *
 * Measured live 2026-09-09 against real Esplora hosts:
 *   blockstream.info  8/8 serial  148 ms/block
 *   mempool.space     8/8 serial   47 ms/block
 *   mempool.space    32 concurrent  3.6 ms/block effective (32/32 ok)
 *
 * So the whole remaining past is ~2.6 hours serial on the faster host, and
 * ~12 minutes at 32-way. The 43-day figure was never a vendor limit; it was
 * this constant plus a serial walk.
 *
 * 64 keeps each epoch a bounded unit of work (the hash-link is still verified
 * once per epoch, and a crash mid-epoch re-walks at most 64 blocks) while
 * cutting the epoch count 8x. The fetch inside an epoch is parallel; the
 * INGEST stays ordered, because the witness parse is the CPU cost the original
 * 8 was protecting and because coverage must extend contiguously.
 */
export const EPOCH_WINDOW: Record<string, number> = {
  evm: 2_000,
  solana: 512,
  bitcoin: 64,
};

export function familyOf(chain: ChainId): "evm" | "solana" | "bitcoin" {
  return chain === "solana" ? "solana" : chain === "bitcoin" ? "bitcoin" : "evm";
}

export interface BackfillProgress {
  chain: ChainId;
  from: number;
  to: number;
  linked: boolean;
  tailMoved: boolean;
  reason?: string;
}

/**
 * What the backfill actually needs from a store: a durable tail it can move,
 * and the headers to prove the hash link.
 *
 * Declaring the full PostgresArchiveStore here demanded far more than this
 * worker uses, and it is what broke bitcoin-backfill.test.ts the moment the
 * concrete class grew telemetry methods -- a test that drives the real logic
 * against an in-memory store could no longer typecheck, for a reason having
 * nothing to do with the backfill. Depend on the capability, not the class.
 */
export type BackfillStore = Pick<
  PostgresArchiveStore,
  "getBackfillTail" | "setBackfillTail" | "headersAtHeight" | "getCursor" | "enqueueGap"
>;

export interface BackfillDeps {
  store: BackfillStore;
  /** Ingest one epoch. Returns the LOWEST header it actually persisted. */
  ingestRange: (chain: ChainId, from: number, to: number) => Promise<Header | undefined>;
  /** Gaze pressure per chain, 0..1. Absent means no attention. */
  gaze?: (chain: ChainId) => number;
}

/**
 * How much of a chain's past is still missing, 0..1.
 *
 * 1.0 means nothing before the archive origin has been walked; 0 means the
 * tail has reached the protocol origin and that chain's past is closed.
 */
export function needPast(store: Pick<ArchiveStore, "getCursor">, chain: ChainId, tail: number): number {
  const cursor = store.getCursor(chain);
  if (!cursor) return 0;
  const t0 = protocolT0(chain);
  const span = cursor.finalizedHeight - t0;
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, (tail - t0) / span));
}

/** A chain with no attention still gets this share of the scheduler's regard. */
export const FAIRNESS_FLOOR = 0.15;

/**
 * Pick the chain whose past to walk next.
 *
 * Ranked by remaining past times gaze, with a floor so an unwatched chain's
 * tail keeps moving. A pure gaze ranking would let a chain nobody opens sit at
 * its archive origin forever, which is the "attention decides existence"
 * failure applied to history.
 */
export function pickChain(
  store: BackfillStore,
  chains: ChainId[],
  gaze?: (c: ChainId) => number,
): ChainId | undefined {
  let best: { chain: ChainId; score: number } | undefined;
  for (const chain of chains) {
    const tail = store.getBackfillTail(chain);
    if (tail === undefined) continue;
    const need = needPast(store, chain, tail);
    if (need <= 0) continue; // this chain's past is closed
    const weight = Math.max(FAIRNESS_FLOOR, gaze?.(chain) ?? 0);
    const score = need * weight;
    if (!best || score > best.score) best = { chain, score };
  }
  return best?.chain;
}

export class BackfillWorker {
  private deps: BackfillDeps;
  constructor(deps: BackfillDeps) {
    this.deps = deps;
  }

  /**
   * Walk one epoch of one chain's past.
   *
   * Returns undefined when every chain's tail has reached its protocol origin,
   * which is the only honest way to report "the past is closed".
   */
  async step(chains: ChainId[]): Promise<BackfillProgress | undefined> {
    const { store } = this.deps;
    const chain = pickChain(store, chains, this.deps.gaze);
    if (!chain) return undefined;

    const tail = store.getBackfillTail(chain)!;
    const t0 = protocolT0(chain);
    const window = EPOCH_WINDOW[familyOf(chain)] ?? 512;
    const from = Math.max(t0, tail - window);
    const to = tail - 1;
    if (to < from) return { chain, from: tail, to: tail, linked: true, tailMoved: false, reason: "tail is at protocol_t0" };

    const lowest = await this.deps.ingestRange(chain, from, to);
    if (!lowest) {
      return { chain, from, to, linked: false, tailMoved: false, reason: "epoch produced no header" };
    }

    // The hash link. The block just below the old tail must be the parent of
    // the tail block we already hold, or these are not the same chain.
    const tailHeader = store
      .headersAtHeight(chain, tail)
      .find((h) => h.height === tail);
    const linked =
      !tailHeader ||
      store.headersAtHeight(chain, to).some(
        (h) => h.hash.toLowerCase() === tailHeader.parentHash.toLowerCase(),
      );

    if (!linked) {
      // Refuse to move. An unlinked boundary is a claim we cannot support.
      //
      // BUT SAY WHICH HASHES DISAGREED. "did not hash-link" is true and
      // useless: it cannot distinguish a genuine reorg from a poisoned
      // parent_hash in our own row, and those need opposite responses. This
      // stalled Bitcoin's past for a full day while the reason string looked
      // like a considered refusal rather than a data defect.
      const expected = tailHeader?.parentHash ?? null;
      const found = store.headersAtHeight(chain, to).map((h) => h.hash);
      store.enqueueGap({ chain, fromHeight: from, toHeight: to, reason: "bloom_audit" });
      return {
        chain,
        from,
        to,
        linked: false,
        tailMoved: false,
        reason:
          `epoch did not hash-link: tail ${tail} expects parent ${expected ?? "(none)"}, ` +
          `but height ${to} holds ${found.length === 0 ? "(no header)" : found.join(",")}`,
      };
    }

    const moved = store.setBackfillTail(chain, lowest.height);
    return { chain, from, to, linked: true, tailMoved: moved };
  }
}
