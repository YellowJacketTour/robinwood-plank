/**
 * King of the Hill — pure decision rules.
 *
 * Deliberately has zero I/O so the exploitability/edge-case guarantees can be
 * unit-tested without a database: see test/market/king-of-the-hill-rules.test.ts.
 * lib/market/king-of-the-hill.ts is the thin Postgres wrapper that loads a
 * KothState, calls the functions here, and writes the result back — that file
 * owns locking/persistence, this one owns the actual rule.
 *
 * THE RULE (verbatim from the pinned tweet this implements):
 *   "when timer is within 2 hours, any new largest sale will extend a grace
 *    period of 4 hours to place the new highest sale... once sustained king
 *    of the hill is timed out, the winner will be awarded."
 */

export const GRACE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const EXTENSION_MS = 4 * 60 * 60 * 1000;

export type KothSale = {
  txHash: string;
  tokenId: string | null;
  wallet: string | null;
  /** Decimal wei string. */
  priceWei: string;
};

export type KothState = {
  deadlineMs: number;
  leadingSale: KothSale | null;
  winnerFinalizedAtMs: number | null;
  winnerSale: KothSale | null;
};

/**
 * Seed a newly-created round from the highest sale already in the ledger.
 * Historical state establishes the starting record but is not a new bid, so
 * it must not extend the deadline or replace an existing leader/winner.
 */
export function seedExistingSale(state: KothState, sale: KothSale): KothState {
  if (state.leadingSale != null || state.winnerFinalizedAtMs != null) return state;
  return { ...state, leadingSale: sale };
}

/**
 * Reconcile a historical ledger sale that was priced after the round state
 * was first observed. Historical reconciliation may repair the leader, but it
 * is not a new bid and therefore must never move the deadline.
 */
export function reconcileExistingSale(state: KothState, sale: KothSale): KothState {
  if (state.winnerFinalizedAtMs != null) return state;
  if (state.leadingSale != null && BigInt(sale.priceWei) <= BigInt(state.leadingSale.priceWei)) {
    return state;
  }
  return { ...state, leadingSale: sale };
}

/**
 * Apply one confirmed sale as a KOTH candidate.
 *
 * Guards, in order:
 *  1. Finalized rounds are immutable — nothing after finalize can move the
 *     leading sale or the deadline, ever, regardless of price.
 *  2. A sale observed after the deadline has already passed cannot revive the
 *     round. The round is over until (and unless) `finalize` runs — it is
 *     never re-opened by a late sale. This is what stops the boundary-timing
 *     exploit: an attacker cannot race a "new highest sale" against the
 *     finalize check and win by landing microseconds after the deadline —
 *     late is late, full stop.
 *  3. Only a STRICTLY higher price is a "new largest sale". A tie or lower
 *     sale changes nothing (no deadline movement, no leading-sale change),
 *     which is what makes rapid tiny-increment spam at the boundary
 *     pointless: each candidate must clear the current record by more than
 *     zero to have any effect, and every accepted extension moves the
 *     deadline a FIXED 4 hours into the future from a floor of "now" — an
 *     attacker gains nothing by submitting many sales instead of one, the
 *     round simply runs until real sales stop beating the record within the
 *     grace window.
 *
 * EXTENSION ANCHOR — why `max(now, deadline) + EXTENSION_MS`:
 * The grace window is [deadline - 2h, deadline]. A qualifying sale can land
 * anywhere in that window, including a few seconds before the old deadline.
 * Anchoring the new deadline to "now + 4h" would let a sale that arrives
 * right at the edge produce a shorter effective extension than one that
 * arrives earlier in the window (both should guarantee a full 4 hours to
 * respond). Anchoring to "old deadline + 4h" instead would make repeated
 * near-simultaneous higher bids each push the deadline out further than the
 * tweet's stated single 4-hour grace, compounding indefinitely. Taking the
 * GREATER of the two and adding 4 hours gives every qualifying sale exactly
 * a 4-hour window to be topped, with no double-counting and no shrinkage —
 * the simplest rule consistent with "any new largest sale...extend...4
 * hours".
 */
export function applyCandidateSale(state: KothState, sale: KothSale, nowMs: number): KothState {
  if (state.winnerFinalizedAtMs != null) return state;
  if (nowMs > state.deadlineMs) return state;

  const candidatePrice = BigInt(sale.priceWei);
  const leadingPrice = state.leadingSale ? BigInt(state.leadingSale.priceWei) : null;
  if (leadingPrice != null && candidatePrice <= leadingPrice) return state;

  const withinGrace = nowMs >= state.deadlineMs - GRACE_WINDOW_MS;
  const deadlineMs = withinGrace ? Math.max(nowMs, state.deadlineMs) + EXTENSION_MS : state.deadlineMs;

  return { ...state, leadingSale: sale, deadlineMs };
}

/**
 * Finalize the round if (and only if) real time has passed the stored
 * deadline. Idempotent: once `winnerFinalizedAtMs` is set this is a no-op
 * forever, so calling it on every read (lazy check-on-read) is safe and
 * cannot double-finalize or flip a winner.
 */
export function finalizeIfDue(state: KothState, nowMs: number): KothState {
  if (state.winnerFinalizedAtMs != null) return state;
  if (nowMs <= state.deadlineMs) return state;
  return { ...state, winnerFinalizedAtMs: nowMs, winnerSale: state.leadingSale };
}
