/**
 * What a hub row's 24h/7d/30d activity cell should actually SAY.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Measured on plank.love 2026-09-12 by fetching the real hub index
 * (`GET /api/market/multichain?limit=12&v=index-3`, HTTP 200, 24,598 bytes)
 * and reading the rows it returned. Cells rendered the `unfetched` typed
 * hole -- "not yet", which means WE HAVE NEVER LOOKED -- over data we had,
 * in fact, already looked at and recorded:
 *
 *   RobinWood (home, chain `robinhood`)
 *       floorPriceWei 9000000000000000, listedCount 76, holderCount 298,
 *       sales24h 0, volume24hWei null, floorChangePct 0,
 *       floorChangeStatus "observed-24h"
 *
 *     `sales24h` is the NUMBER ZERO, not null. salesStatsFromLedger() read
 *     plank_chain_events and counted no sale in the window. That is a
 *     measurement, and the honest rendering of a measured zero is "0" -- the
 *     `none` kind, which TypedHole has always had and which nothing ever
 *     passed. Instead displaySales() mapped 0 -> null and the cell claimed
 *     the value had never been fetched. The home collection, the one row
 *     with first-party data, was the row most confidently lying about it.
 *
 *     The change cell was worse. `floorChangeStatus` was "observed-24h" --
 *     two real floor observations 24 h apart, both 0.009 ETH, a genuinely
 *     flat tape -- so the render never reached the "collecting baseline"
 *     branch that every other row took. displayChangePct() then suppressed
 *     the 0 (correctly: a stored 0 with no trades behind it is not a
 *     measured flat move) and the cell fell through to `unfetched`. So
 *     RobinWood alone showed "not yet" where every other row showed
 *     "collecting baseline": not a hydration gap, a fall-through.
 *
 *   Beezie - Base (base-mainnet 0xbb5e...a16f)
 *       sales24h 1587, sales7d 11179, sales30d 11179,
 *       volume24hWei null, volume7dWei null, volume30dWei null
 *
 *     11,179 recorded sales in 30 days and not one wei of volume in ANY
 *     window. That is not an un-run lane. updateVolumeFromMarketEvents()
 *     (lib/market/multichain/store.ts) computes both halves in ONE query:
 *     `COUNT(*)` over every sale, and `SUM(native_wei)` where
 *
 *         native_wei = CASE WHEN currency_address IS NULL
 *                            OR lower(currency_address) IN (<wrapped native>,
 *                                                           <zero address>)
 *                        THEN amount_atomic ELSE NULL END
 *
 *     -- deliberately NULL for a sale denominated in anything else, because
 *     summing USDC atomic units into a wei total would be a fabricated
 *     number. Beezie settles in a non-native currency, so COUNT survives and
 *     SUM(native_wei) is NULL. Correct arithmetic; the cell then reported it
 *     as "never fetched".
 *
 *     The same query already computes `SUM(amount_usd)` over EVERY sale
 *     regardless of denomination, and updateCollectionMarketStats() already
 *     writes it to plank_multichain_snapshots.volume_24h_usd / _7d_ / _30d_.
 *     Grepping the repo for that column found four hits, all in store.ts,
 *     all writes. Nothing has ever read it. The number was computed, stored,
 *     and thrown away, and the UI said "not yet" over the top of it.
 *
 * THE RULE THIS ENCODES
 * ---------------------
 * Nothing here invents a value. Each branch below reports a fact the
 * pipeline already established, and the ONLY reason any of them was missing
 * from the screen is that the render path had no branch for it:
 *
 *   - a counted zero is `none` and renders "0"
 *   - a real USD sum with no native-wei sum is a VALUE, shown in USD, with
 *     the reason stating the denomination
 *   - a value we have genuinely never computed stays `unfetched`
 *
 * If the data is not there, it still renders a hole. An honest hole beats a
 * confident wrong number; it does not beat a number we already measured.
 */

/** The activity numbers a hub row carries for one display window. */
export interface WindowActivityInput {
  /** Native-currency sum for the window, atomic units. Null when no sale in the window settled in the chain's native or wrapped-native currency. */
  volumeWei: string | null | undefined;
  /** USD sum for the window over EVERY sale, whatever it settled in. Null when no sale carried a priced USD amount. */
  volumeUsd: string | null | undefined;
  /** Sale COUNT for the window. `0` is a measurement; `null` means the count was never computed. */
  sales: number | null | undefined;
}

export type WindowVolumeDisplay =
  /** A real native-currency sum. Render it in the chain's coin. */
  | { kind: "native"; wei: string }
  /**
   * No native sum, but a real USD sum over sales that settled in another
   * currency. Render the dollars; never convert them back into a wei figure,
   * which would invent a native-denominated trade that never happened.
   */
  | { kind: "usd"; usd: number; sales: number | null }
  /** Sales were counted and there were none. A measured zero, not a gap. */
  | { kind: "zero" }
  /** Genuinely not computed, or counted but never priced. */
  | { kind: "absent" };

function positiveWei(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  try {
    return BigInt(value) > 0n ? value : null;
  } catch {
    return null;
  }
}

function positiveUsd(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * What the volume cell for one window should render.
 *
 * Order matters and is not arbitrary. A native-currency sum is the most
 * precise thing we hold, so it wins. A USD sum is the SAME aggregation's
 * other output and is the only honest figure for a collection that trades in
 * USDC -- it is preferred over a hole because it is a real measurement, and
 * it is labelled as dollars rather than silently rendered as the chain's
 * coin. Only when neither exists does the count decide between "measured
 * zero" and "never computed".
 */
export function windowVolumeDisplay(input: WindowActivityInput): WindowVolumeDisplay {
  const wei = positiveWei(input.volumeWei);
  if (wei != null) return { kind: "native", wei };
  const usd = positiveUsd(input.volumeUsd);
  const sales = input.sales ?? null;
  if (usd != null) return { kind: "usd", usd, sales };
  // A counted zero settles it: nothing traded, so there is no volume, and
  // that is an answer rather than an absence.
  if (sales === 0) return { kind: "zero" };
  // Sales exist but neither sum does: we counted trades and priced none of
  // them. Still a hole -- but see volumeHoleKindFor(): it is NOT `unfetched`,
  // because asking the same lane again produces the same unpriced count.
  return { kind: "absent" };
}

/**
 * What the sales cell for one window should render.
 *
 * `0` is the whole point. Before this, displaySales() collapsed 0 into null
 * and the cell said "not yet" -- which is how RobinWood, whose ledger we own
 * outright, ended up claiming its own sale count had never been fetched.
 */
export function windowSalesDisplay(
  sales: number | null | undefined,
): { kind: "count"; sales: number } | { kind: "zero" } | { kind: "absent" } {
  if (sales == null || !Number.isFinite(sales)) return { kind: "absent" };
  if (sales < 0) return { kind: "absent" };
  if (sales === 0) return { kind: "zero" };
  return { kind: "count", sales };
}

/**
 * The hole kind for a volume cell that has no displayable value.
 *
 * `unfetched` is a WORK ORDER -- isSchedulable() returns true for it alone,
 * and the attention beam queues on it. Queueing a collection whose sales we
 * have already counted and whose fills carry no native price is work that
 * cannot succeed: the lane will run, count the same trades, and write the
 * same NULL. That is `underived` -- a real precondition (a natively
 * denominated or USD-priced fill) is missing, and time rather than a request
 * is what supplies it.
 */
export function volumeHoleKindFor(input: WindowActivityInput): "unfetched" | "underived" | "none" {
  const display = windowVolumeDisplay(input);
  if (display.kind === "zero") return "none";
  if ((input.sales ?? 0) > 0) return "underived";
  return "unfetched";
}

/**
 * The final kind a hub cell renders, given everything known about it.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES INSIDE holeFor().
 * ----------------------------------------------------------
 * A mutation test on 2026-09-12 deleted the `established ??` from holeFor()
 * -- reverting every user-visible part of this fix, so a measured zero went
 * straight back to reading "not yet" -- and the whole suite stayed GREEN.
 * The tests covered the classifier and covered the call sites, and nothing
 * covered the one line that joins them.
 *
 * holeFor() lives inside a "use client" component and returns JSX, so it
 * cannot be driven from a node:test process. The resolution rule was
 * therefore untestable where it sat. Moving it here makes the join itself
 * executable by a test, which is the only way that mutation gets caught.
 *
 * PRECEDENCE, AND WHY IT IS THIS WAY ROUND
 * ----------------------------------------
 * `unsourced` outranks everything: a chain with no endpoint for a field
 * cannot be made to have one by anything on the row, and calling such a cell
 * `unfetched` would queue work in the attention beam that can never succeed.
 * Below that, a kind ESTABLISHED from this row's own numbers beats the
 * generic classification, because classifyHole() cannot see a window's
 * counted zero or an observed-and-flat floor -- exactly the two blind spots
 * that produced the false "not yet" holes on production.
 */
export function resolveHoleKind(input: {
  /** True when the chain has no source for this field at all. */
  chainHasNoSource: boolean;
  /** The kind this cell established from the row's own numbers, if any. */
  established?: "unfetched" | "underived" | "none";
  /** The generic classification, used only when nothing was established. */
  fallback: "unfetched" | "unsourced" | "underived" | "none";
}): "unfetched" | "unsourced" | "underived" | "none" {
  if (input.chainHasNoSource) return "unsourced";
  return input.established ?? input.fallback;
}

/**
 * The hole kind for a 24h-change cell that has no displayable percentage.
 *
 * `floorChangeStatus` is the server's own statement about the floor
 * observations behind the row:
 *
 *   "observed-24h"        two comparable observations exist. Whatever the
 *                         change cell shows or suppresses, the value was
 *                         MEASURED. It can never be `unfetched`.
 *   "collecting-baseline" one endpoint exists, the second is pending. Time,
 *                         not a request -> `underived`.
 *   null                  no floor observed at all -> genuinely `unfetched`.
 *
 * RobinWood's live row was "observed-24h" with changePct 0 and no trades, so
 * displayChangePct() suppressed the 0 and the render fell through to
 * `unfetched`. Both floor endpoints measured 0.009 ETH: the floor genuinely
 * did not move. A suppressed zero is `none` when the tape was observably
 * flat, and `underived` when the row has trades but no comparable pair --
 * never a claim that nobody looked.
 */
export function changeHoleKindFor(input: {
  floorChangeStatus: "observed-24h" | "collecting-baseline" | null | undefined;
  /** The raw server value, BEFORE display suppression. */
  rawChangePct: number | null | undefined;
  /** Sales in the window; a change with trades behind it is derivable. */
  sales: number | null | undefined;
}): "unfetched" | "underived" | "none" {
  if (input.floorChangeStatus === "observed-24h") {
    // Two real endpoints. If the server measured exactly 0 the floor did not
    // move, and "0.0%" is the true statement -- reported as `none`, the kind
    // that renders a real value rather than a hole.
    if (input.rawChangePct === 0) return "none";
    return "underived";
  }
  if (input.floorChangeStatus === "collecting-baseline") return "underived";
  if ((input.sales ?? 0) > 0) return "underived";
  return "unfetched";
}
