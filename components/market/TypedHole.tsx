"use client";

/**
 * A typed hole: the visible, honest rendering of a value we do not have.
 *
 * WHY THIS EXISTS
 * ---------------
 * Measured on production 2026-09-09, signed in through the backstage door:
 * 80 % of Global Market rows had no holder count, 85 % no listed count, 68 %
 * no creator badge, 68 % had real sales and a blank 24 h change. Every one of
 * them rendered as the same character: an em-dash.
 *
 * That dash is the most expensive character on the site. It cannot be
 * distinguished from zero, from "not fetched yet", from "this chain has no
 * source for it", or from "we tried and failed -- and because it cannot be
 * distinguished, nobody can act on it. Not the visitor, not the scheduler, not
 * the person reading a bug report.
 *
 * The reasoning already existed and was already good: `emptyCellReason` in
 * GlobalMarketHub.tsx explains, per chain and per field, exactly why a value
 * is absent, and its own comment records that these strings were rewritten
 * once already to stop promising data the pipeline could not deliver. The
 * whole of that truth was then hidden behind a `title` attribute -- invisible
 * until hover, and on a touch device invisible entirely.
 *
 * So this component changes no data and invents no value. It makes an
 * explanation that was always there legible, and gives it a shape the rest of
 * the system can use.
 *
 * THE FOUR KINDS, AND WHY THE DISTINCTION IS LOAD-BEARING
 * ------------------------------------------------------
 *   unfetched  we have not looked yet          -> schedulable, and the beam
 *                                                 should raise its priority
 *   unsourced  no source exists for this chain -> NOT schedulable; fetching
 *                                                 harder will never help
 *   underived  a real precondition is missing  -> e.g. a 24 h change needs a
 *                                                 prior priced window; this is
 *                                                 correct, not broken
 *   none       the chain says there are zero   -> a FACT, and it renders as 0
 *
 * Collapsing these four into one dash is what made 80 % missing look like a
 * defect rather than a work queue. `none` in particular is not a hole at all:
 * a collection with genuinely zero listings should show 0, and showing a dash
 * there is a lie of omission.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a loading spinner, and not a guess. A hole never becomes a plausible
 * number while nobody is looking. The archive's own rule -- say what you can
 * prove, render a typed hole for the rest -- applied to every cell in the UI
 * rather than only to chain coverage.
 */

export type HoleKind = "unfetched" | "unsourced" | "underived" | "none";

export interface TypedHoleProps {
  kind: HoleKind;
  /** The honest, specific explanation. Already written by emptyCellReason. */
  reason: string;
  /** Optional short label override, e.g. "no prior window". */
  label?: string;
  /** Field name, used for the accessible description. */
  field?: string;
}

/**
 * The short text each kind shows inline.
 *
 * Deliberately lowercase and quiet: a hole must not shout louder than a real
 * value, or a table of mostly-holes becomes unreadable and the real numbers
 * stop standing out. The colour and the tooltip carry the detail.
 */
const SHORT: Record<HoleKind, string> = {
  unfetched: "not yet",
  unsourced: "no source",
  underived: "needs history",
  none: "0",
};

/**
 * Tone per kind. `none` is a real value and must read like one; the other
 * three are muted so a row of holes recedes behind the rows that have data.
 */
const TONE: Record<HoleKind, string> = {
  unfetched: "text-amber-300/45",
  unsourced: "text-neutral-500/60",
  underived: "text-neutral-500/60",
  none: "text-neutral-300",
};

export function TypedHole({ kind, reason, label, field }: TypedHoleProps) {
  const text = label ?? SHORT[kind];
  return (
    <span
      className={`text-[11px] leading-none ${TONE[kind]}`}
      title={reason}
      // The explanation must reach a screen reader too. `title` alone is not
      // announced reliably, and a bare dash announces as nothing at all.
      aria-label={field ? `${field}: ${reason}` : reason}
      data-hole={kind}
    >
      {text}
    </span>
  );
}

/**
 * Classify an absent value from what the row already tells us.
 *
 * Pure and side-effect free so it can be unit tested without a DOM, and so the
 * SAME classification can be reused by the scheduler: `unfetched` is the only
 * kind worth queueing, which is exactly the signal the attention beam needs.
 *
 * `sales` is passed for the change case because a 24 h change is only
 * derivable from two priced windows -- a collection with sales but no prior
 * window is `underived`, not `unfetched`, and asking for it again will never
 * produce a number.
 */
export function classifyHole(input: {
  field: "change" | "volume" | "sales" | "listed" | "holders";
  chainSlug: string;
  /** True when the chain has no source for this field at all. */
  chainHasNoSource?: boolean;
  /** For `change`: does the row have real sales in the window? */
  hasSales?: boolean;
  /** True when the value is a genuine, observed zero rather than absent. */
  observedZero?: boolean;
}): HoleKind {
  if (input.observedZero) return "none";
  if (input.chainHasNoSource) return "unsourced";
  // A change with real sales behind it is not missing -- it is not yet
  // derivable, because the prior window holds no priced fill. Queueing it
  // would be work that cannot succeed.
  if (input.field === "change" && input.hasSales) return "underived";
  return "unfetched";
}

/**
 * Is this hole worth scheduling?
 *
 * The bridge between the UI and the attention beam. A rendered hole is a work
 * order ONLY when fetching could actually fill it: `unsourced` cannot be
 * fixed by trying harder, `underived` needs time rather than a request, and
 * `none` is already the answer.
 */
export function isSchedulable(kind: HoleKind): boolean {
  return kind === "unfetched";
}
