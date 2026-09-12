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
 * The old throughput estimate measured header lookups, not complete blocks.
 * A verified read of block 966080 fetched 4,008 transactions in 10.6 seconds
 * including cold provider failover. Four full blocks form a bounded commit
 * unit; backfillTick repeats epochs within its wall-clock budget. The raw
 * reader eliminates the former 500-transaction cap and pagination overhead.
 */
export const EPOCH_WINDOW: Record<string, number> = {
  evm: 2_000,
  solana: 512,
  // Complete raw blocks can contain thousands of transactions each. Keep a
  // commit unit below the worker's phase deadline; the budget loop repeats it.
  bitcoin: 4,
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
  | "getBackfillTail"
  | "setBackfillTail"
  | "headersAtHeight"
  | "getCursor"
  | "enqueueGap"
  // Added for the in-place self-parent repair below. Declared explicitly
  // rather than widening back to the whole class: this type exists so the
  // worker's dependencies stay legible, and the compiler correctly rejected
  // the first attempt to use methods that were not part of the contract.
  | "putHeader"
  | "repairParentHash"
>;

export interface BackfillDeps {
  store: BackfillStore;
  /** Ingest one epoch. Returns the LOWEST header it actually persisted. */
  ingestRange: (chain: ChainId, from: number, to: number, deadline?: number) => Promise<Header | undefined>;
  /** Gaze pressure per chain, 0..1. Absent means no attention. */
  gaze?: (chain: ChainId) => number;
  /**
   * Fraction of the tape size budget already consumed, 0..1. Absent means the
   * store cannot measure itself, and the budget is not enforced -- which is
   * correct for the in-memory store, and is why this is optional rather than
   * defaulting to 0 (a default of 0 would claim an empty tape it never read).
   */
  tapeUsage?: TapeUsage;
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
 * THE SIZE BUDGET. The tape's only ceiling.
 *
 * WHY THE PAST NEEDS A STOP AND THE TIP DOES NOT
 * ----------------------------------------------
 * `finalized_head` advances at the rate real blocks are produced -- slow, and
 * bounded by physics. `backfill_tail` has no such governor: it walks LEFTWARD
 * as fast as the host can drink, across eleven chains, and nothing in this
 * package or in 112 migrations ever told it to stop. A grep of every migration
 * for DELETE/retention/prune/TTL finds exactly one prune in the whole schema
 * (plank_prune_floor_observations, migration 108) and it does not cover the
 * tape.
 *
 * Bitcoin alone is ~191k blocks of remaining past; akasha_event carries a
 * `raw JSONB` per row plus two indexes. The failure mode is not a slow query,
 * it is a full disk on a shared cPanel host -- which takes the web role and
 * the mesh down with it, because they share the same volume and the same
 * PGPOOL_MAX=4.
 *
 * WHY A BUDGET AND NOT A PRUNE
 * ----------------------------
 * Deleting old events is the obvious move and it is WRONG here. The tape's one
 * real reader, lib/market/multichain/discovery/akasha-bridge.ts, aggregates
 * over ALL `envelope` events with no time predicate:
 *
 *     SELECT e.raw->>'parent', COUNT(DISTINCT e.token_or_inscription)
 *       FROM akasha_event e WHERE e.chain='bitcoin' AND e.kind='envelope'
 *
 * Those counts ARE collection membership. A time-based prune would silently
 * shrink every Bitcoin collection's size -- a wrong number that reports itself
 * as fine, which is the exact failure species this package exists to refuse.
 *
 * So the budget stops the tape GROWING rather than throwing away what it
 * holds. The past stops advancing; nothing already proven is surrendered.
 *
 * WHY IT REPORTS RATHER THAN SILENTLY HALTING
 * -------------------------------------------
 * A backfill that quietly stops is indistinguishable from one that finished.
 * `step()` returns a progress record whose `reason` names the budget, so the
 * worker's own telemetry shows "held by size budget" instead of the silence
 * that a completed past would produce.
 */
export const DEFAULT_TAPE_BUDGET_BYTES = 60 * 1024 * 1024 * 1024; // 60 GiB

/**
 * How much of the budget is already spent, 0..1, or undefined when the store
 * cannot measure itself (an in-memory store under test).
 *
 * Deliberately a callback rather than a direct query: measuring size is a
 * Postgres-specific act, and the worker must keep running against stores that
 * cannot do it. An unmeasurable tape is NOT treated as an empty one.
 */
export type TapeUsage = () => number | undefined;

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
  async step(chains: ChainId[], deadline?: number): Promise<BackfillProgress | undefined> {
    const { store } = this.deps;
    const chain = pickChain(store, chains, this.deps.gaze);
    if (!chain) return undefined;

    // THE BUDGET GATE. Checked after a chain is picked so the refusal can name
    // one, and BEFORE any network call so a full tape costs nothing to hold.
    //
    // `undefined` means the store cannot measure itself and the budget does
    // not apply. That is deliberately NOT the same as 0: an unmeasurable tape
    // must not be reported as an empty one.
    const used = this.deps.tapeUsage?.();
    if (used !== undefined && used >= 1) {
      return {
        chain,
        from: store.getBackfillTail(chain)!,
        to: store.getBackfillTail(chain)!,
        linked: true,
        tailMoved: false,
        // Say it plainly. A backfill that stops silently is indistinguishable
        // from one that finished, and those are opposite facts.
        reason:
          `held by tape size budget: ${(used * 100).toFixed(1)}% of ` +
          `DEFAULT_TAPE_BUDGET_BYTES consumed -- the past is NOT closed, it is ` +
          `paused. Raise the budget or move the tape off this volume.`,
      };
    }

    const tail = store.getBackfillTail(chain)!;
    const t0 = protocolT0(chain);
    const window = EPOCH_WINDOW[familyOf(chain)] ?? 512;
    const from = Math.max(t0, tail - window);
    const to = tail - 1;
    if (to < from) return { chain, from: tail, to: tail, linked: true, tailMoved: false, reason: "tail is at protocol_t0" };

    const lowest = await this.deps.ingestRange(chain, from, to, deadline);
    if (!lowest) {
      return { chain, from, to, linked: false, tailMoved: false, reason: "epoch produced no header" };
    }

    // The hash link. The block just below the old tail must be the parent of
    // the tail block we already hold, or these are not the same chain.
    const tailHeader = store
      .headersAtHeight(chain, tail)
      .find((h) => h.height === tail);
    let linked =
      !!tailHeader && store.headersAtHeight(chain, to).some(
        (h) => h.hash.toLowerCase() === tailHeader.parentHash.toLowerCase(),
      );
    // Every seam in the newly ingested interval must link, including holes
    // inside an epoch. Endpoint agreement alone cannot certify the interval.
    let expectedHash = tailHeader?.parentHash;
    for (let height = to; linked && height >= lowest.height; height--) {
      const header = store.headersAtHeight(chain, height).find((h) => h.hash === expectedHash);
      linked = !!header;
      expectedHash = header?.parentHash;
    }

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

      // SELF-HEAL A SELF-PARENT, HERE, WITH NO NETWORK CALL.
      //
      // A row whose parent_hash equals its own hash is not a reorg and not a
      // disagreement with the chain -- it is a placeholder that was never
      // overwritten, and it is detectable by pure comparison. Recognising it
      // needs no vendor, no header fetch, and cannot fail.
      //
      // This existed only in the BOOT path, which meant a poisoned row
      // discovered mid-run waited for the next hourly restart -- and if that
      // one boot-time header read failed, waited another hour. Measured live
      // 2026-09-09: block 966081 stayed self-parented across multiple boots
      // while the backfill refused, correctly, every 15 seconds.
      //
      // The repair is narrow on purpose: it fires ONLY when the stored parent
      // is the block's own hash AND exactly one header is stored at the height
      // below. That is the single unambiguous case -- any other mismatch is a
      // real claim about the chain and must keep being refused.
      if (
        tailHeader &&
        expected &&
        expected.toLowerCase() === tailHeader.hash.toLowerCase() &&
        found.length === 1
      ) {
        const realParent = found[0]!;
        store.putHeader({ ...tailHeader, parentHash: realParent });
        store.repairParentHash(chain, tailHeader.hash, realParent);
        return {
          chain,
          from,
          to,
          linked: false,
          tailMoved: false,
          reason:
            `self-parented tail ${tail} repaired in place: parent ${expected} -> ${realParent}; ` +
            `the next epoch will link`,
        };
      }

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
    // A SUCCESSFUL STEP THAT MOVES NOTHING MUST STILL SAY WHY.
    //
    // This returned `tailMoved: moved` with NO reason, so a refused tail
    // update surfaced as the caller's fallback string -- "no progress, no
    // reason given" -- which is precisely the silent-miss shape the rest of
    // this file exists to prevent.
    //
    // setBackfillTail only moves LEFT, so `moved` is false when the lowest
    // header we actually persisted sits at or above the current tail. That
    // happens when the BOTTOM of the epoch failed to ingest: the walk
    // succeeded, the hash-link held, and the deepest block we hold is still
    // the one we already had. Measured live 2026-09-09 with backfill
    // ok 285 / fail 183 -- partial epochs, not a stalled worker.
    return {
      chain,
      from,
      to,
      linked: true,
      tailMoved: moved,
      reason: moved
        ? `tail moved ${tail} -> ${lowest.height}`
        : `epoch linked but the tail did not move: lowest header persisted was ` +
          `${lowest.height}, which is not below the tail ${tail} -- the bottom of ` +
          `the epoch (${from}) did not ingest`,
    };
  }
}
