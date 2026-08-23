/**
 * Real, computable "dormant" classification -- deliberately separate from
 * gradeScore() (market-readiness) and computeDemandScore() (popularity):
 * this answers a third, distinct question -- "is there any real recent
 * sign of life at all" -- so a default browse/search/trending surface can
 * deprioritize a collection with none, without ever deleting or hiding its
 * data. A collection classified dormant is still fully queryable; this only
 * powers a deprioritization signal for default-view ordering/badging.
 *
 * Chain-agnostic on purpose: every chain this app tracks (EVM, Solana,
 * Bitcoin/Ordinals, Robinhood-native) already populates the same three
 * fields on TrackedCollection (see components/market/GlobalMarketHub.tsx's
 * own doc comments) -- sales30d, volume30dWei, listedCount, holderCount --
 * so this needs no chain-specific branch.
 *
 * DELIBERATELY CONSERVATIVE (false positives are worse than false
 * negatives here, per the owner's own instruction): dormant requires ALL
 * of the following, not any one weak signal alone --
 *   1) zero real sales in the longest window this app actually stores
 *      (30d -- there is no persisted 90d sales window today, so this is
 *      honestly the 30d field, not a fabricated 90d one),
 *   2) zero real $ volume in that same window (both must be zero, not
 *      just sales=null which could mean "never fetched" rather than
 *      "genuinely dead" -- see note below), and
 *   3) no live executable listings right now (listedCount is 0 or null)
 *      -- a collection with a thin but real ask book is not dead even
 *      absent a sale in 30 days; it is illiquid but present.
 * A collection whose sales30d/volume30dWei were simply never fetched
 * (both null, not both "0"/0) is classified NOT dormant -- "we don't have
 * data yet" must never be conflated with "this is confirmed dead."
 */

export type DormancyInput = {
  sales30d: number | null;
  volume30dWei: string | null;
  listedCount: number | null;
  /** Real distinct-owner count, when known -- used only to sharpen the reason text, never to flip the verdict alone (see holderCount<=1 note below). */
  holderCount: number | null;
};

export type DormancyResult = {
  dormant: boolean;
  /** Null when not dormant. Human-readable, cites the exact real signals that produced the verdict -- never a vague "looks dead". */
  reason: string | null;
};

function isZeroVolume(volume30dWei: string | null): boolean {
  if (volume30dWei == null) return false;
  try {
    return BigInt(volume30dWei) <= BigInt(0);
  } catch {
    return false;
  }
}

export function classifyDormancy(input: DormancyInput): DormancyResult {
  // Both fields must actually be PRESENT (fetched) and both known-zero --
  // a single missing field means "never fetched," which must never read as
  // "confirmed dead" (see module doc comment).
  if (input.sales30d == null || input.volume30dWei == null) return { dormant: false, reason: null };
  const confirmedNoSales = input.sales30d === 0 && isZeroVolume(input.volume30dWei);
  if (!confirmedNoSales) return { dormant: false, reason: null };

  const noListings = input.listedCount == null || input.listedCount <= 0;
  if (!noListings) return { dormant: false, reason: null };

  const holderNote = input.holderCount != null
    ? `; ${input.holderCount} distinct holder${input.holderCount === 1 ? "" : "s"}`
    : "";
  return {
    dormant: true,
    reason: `No sales and no $ volume in the last 30 days, and no live listings right now${holderNote}.`,
  };
}
