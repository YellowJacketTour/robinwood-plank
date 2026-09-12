/**
 * Monotone derivation: values that can be RETRACTED.
 *
 * WHY THIS EXISTS
 * ---------------
 * Hellerstein's CALM theorem states that a program has a consistent,
 * coordination-free distributed implementation if and only if it is MONOTONIC
 * -- once something is established true, later information cannot refute it.
 * Selection, projection, join and union are monotone. Counting, negation,
 * universal quantification, `max` and set-difference are not.
 *
 * Every hard-won bug in this file's neighbourhood is a non-monotone operation
 * on a critical path:
 *
 *   - THE MALL RATCHET (archival-ledger.ts). `max(token_id)` is a monotone
 *     AGGREGATE with NO INVERSE: there is no way to un-observe the largest id
 *     and recover the previous one, because the previous one was never kept.
 *     Migration 106 cleared Friendship Bracelets' known_supply so a better
 *     value could be written, which re-enabled the id-inference branch, and an
 *     Art Blocks id near 2,038,964 immediately re-inflated it. Measured live
 *     2026-09-08: the value came back LARGER (2,000,343) than the 2,000,335
 *     the migration had just cleared.
 *
 *     That is not a coding error. It is a mathematical property. `max` cannot
 *     retract, so a poisoned observation is permanent, and the only available
 *     repair is to guard every path that feeds it -- which is what the code
 *     does today, one hand-written guard per discovered vector.
 *
 *   - COVERAGE advancing over a bloom filter that matched nothing, and a
 *     "catalog exhausted" claim, are both non-existence claims: the strongest
 *     non-monotone statement there is.
 *
 * WHAT THIS MODULE PROVIDES
 * -------------------------
 * A `Monotone<T>` carries the EVIDENCE its value was derived from, keyed by a
 * source id, rather than only the folded result. That single change makes the
 * fold invertible: retracting a source removes its contribution and the value
 * is recomputed from what remains. A reorg, a poisoned vendor row, or a
 * migration clearing a field all become the same ordinary operation -- a
 * retraction -- instead of three different hand-written repairs.
 *
 * This is deliberately NOT a differential-dataflow engine. d2ts exists and is
 * explicitly alpha; staking the archive on it would be reckless. What is
 * adopted here is the DISCIPLINE -- evidence-carrying, retractable folds --
 * which is the part that actually prevents the bug class, and which needs no
 * dependency at all.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a cache, and it does not replace the existing guards. Those guards
 * encode REAL DOMAIN KNOWLEDGE (Art Blocks packs projectId into the token id;
 * a mall core's id space says nothing about one project's supply) that no
 * generic algebra can infer. This makes the guards' job possible rather than
 * heroic: a wrong observation can now be withdrawn instead of being permanent.
 */

/** One piece of evidence: who said it, and what they said. */
export type Observation<V> = {
  /**
   * Stable identity of the SOURCE, not of the value. Retraction is by source,
   * because "this vendor was wrong" is the thing we actually learn.
   */
  readonly source: string;
  readonly value: V;
};

/**
 * A value plus the evidence it was folded from.
 *
 * `value` is always exactly `fold(observations)` -- it is never patched
 * independently, which is what keeps it recomputable.
 */
export type Monotone<V, R> = {
  readonly observations: ReadonlyMap<string, V>;
  readonly value: R;
};

export type Fold<V, R> = {
  /** Result for an EMPTY evidence set. Must be honest: usually null, never 0. */
  readonly empty: R;
  /** Combine one observation into an accumulator. Must be order-independent. */
  readonly step: (acc: R, v: V) => R;
};

function recompute<V, R>(obs: ReadonlyMap<string, V>, fold: Fold<V, R>): R {
  let acc = fold.empty;
  for (const v of obs.values()) acc = fold.step(acc, v);
  return acc;
}

export function monotone<V, R>(fold: Fold<V, R>, initial: Array<Observation<V>> = []): Monotone<V, R> {
  const obs = new Map<string, V>();
  for (const o of initial) obs.set(o.source, o.value);
  return { observations: obs, value: recompute(obs, fold) };
}

/**
 * Add or REPLACE one source's observation.
 *
 * Replacement matters as much as addition: a vendor that corrects itself must
 * not have both its old and new claims counted, which is exactly what happens
 * when a fold only ever sees a stream of values with no identity.
 */
export function observe<V, R>(m: Monotone<V, R>, fold: Fold<V, R>, o: Observation<V>): Monotone<V, R> {
  const obs = new Map(m.observations);
  obs.set(o.source, o.value);
  return { observations: obs, value: recompute(obs, fold) };
}

/**
 * THE OPERATION `max` CANNOT DO ON ITS OWN.
 *
 * Withdraw a source's evidence and recompute from what is left. This is the
 * whole point: with the observations kept, even a non-invertible aggregate
 * becomes retractable, because the fold is re-run rather than un-done.
 *
 * Retracting an unknown source is a no-op, not an error -- "this source was
 * wrong" must be safe to say twice, and safe to say about a source that was
 * already removed.
 */
export function retract<V, R>(m: Monotone<V, R>, fold: Fold<V, R>, source: string): Monotone<V, R> {
  if (!m.observations.has(source)) return m;
  const obs = new Map(m.observations);
  obs.delete(source);
  return { observations: obs, value: recompute(obs, fold) };
}

/** Retract several sources at once -- a reorg withdraws every event in a block. */
export function retractAll<V, R>(m: Monotone<V, R>, fold: Fold<V, R>, sources: Iterable<string>): Monotone<V, R> {
  const obs = new Map(m.observations);
  let changed = false;
  for (const s of sources) changed = obs.delete(s) || changed;
  if (!changed) return m;
  return { observations: obs, value: recompute(obs, fold) };
}

// --- folds -----------------------------------------------------------------

/**
 * The retractable `max`. The fold the mall ratchet needed.
 *
 * `empty` is null, NOT 0 or -Infinity: with no evidence the honest answer is
 * "unknown". A numeric default here would be a fabricated observation, and
 * downstream code cannot tell a real 0 from an invented one.
 */
export const maxFold: Fold<number, number | null> = {
  empty: null,
  step: (acc, v) => (acc == null || v > acc ? v : acc),
};

/**
 * Counting is the canonical non-monotone operation, and it is safe here for
 * exactly one reason: the evidence set is the thing being counted, so removing
 * a source removes its contribution by construction.
 */
export const countFold: Fold<unknown, number> = {
  empty: 0,
  step: (acc) => acc + 1,
};

/** Sum, retractable. Same reasoning as count. */
export const sumFold: Fold<number, number> = {
  empty: 0,
  step: (acc, v) => acc + v,
};

/**
 * Minimum non-null -- a floor price across venues.
 *
 * `empty` is null because "no venue is offering this" and "the floor is zero"
 * are different facts, and conflating them is how a free NFT gets displayed.
 */
export const minFold: Fold<number, number | null> = {
  empty: null,
  step: (acc, v) => (acc == null || v < acc ? v : acc),
};

/**
 * Union of ids -- holders of a collection, tokens in a set.
 *
 * Returns a fresh Set per recompute rather than mutating, so a retraction
 * cannot leave a stale member behind. That is the same class of bug as
 * putHeader keeping a stale copy (akasha pg-store), and it is worth the
 * allocation.
 */
export const unionFold: Fold<readonly string[], ReadonlySet<string>> = {
  empty: new Set<string>(),
  step: (acc, v) => {
    const next = new Set(acc);
    for (const id of v) next.add(id);
    return next;
  },
};
