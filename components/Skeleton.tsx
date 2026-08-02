/**
 * Shared loading placeholders.
 *
 * DESIGN.md already calls loading a first-class component state; what drifted
 * was the implementation. Six surfaces had each rolled their own pulse markup
 * and several had none at all, so a slow read showed either bare prose
 * ("Connecting to Robinhood Chain…") or, worse, an empty state — a populated
 * marketplace flashing as "No listings yet" on every visit.
 *
 * The rule these encode: a skeleton stands in for the SHAPE of the content it
 * replaces, not for "something is happening". A card grid loads as a card
 * grid, a table as rows, a stat strip as tiles. Generic grey boxes are easier
 * to write and cause the layout to jump when the real data lands, which is the
 * jank the skeleton was supposed to prevent.
 *
 * Accessibility: these are decorative and marked aria-hidden, because a screen
 * reader announcing a dozen fake rows is noise. Pair them with a single live
 * region describing the wait — <SkeletonStatus> below — rather than leaving the
 * loading state unannounced.
 *
 * Motion: the pulse is suppressed under prefers-reduced-motion via
 * motion-reduce:animate-none. A full-viewport pulse is exactly the kind of
 * repetitive motion that setting exists to stop.
 */

const PULSE = "animate-pulse motion-reduce:animate-none";

/** One placeholder rectangle. The building block for the rest. */
export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <div className={`${PULSE} rounded bg-panel ${className}`} aria-hidden="true" />;
}

/**
 * Announce the wait once, for assistive tech, while the visual skeletons stay
 * silent. Keep the message specific ("Loading listings") — "Loading" alone
 * tells a screen-reader user nothing about what they are waiting for.
 */
export function SkeletonStatus({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {children}
    </p>
  );
}

/** Stacked text lines. `lines` short bars of decreasing width. */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  const widths = ["w-3/4", "w-full", "w-2/3", "w-5/6", "w-1/2"];
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`${PULSE} h-3 rounded bg-panel ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}

/**
 * NFT card grid. Mirrors the real card: square art, then a title line, a
 * subtitle and an optional action bar, inside the same dense-card frame — so
 * nothing shifts when the data arrives.
 *
 * `columns` takes the grid classes of the surface it stands in for; the default
 * matches the gallery's auto-fill grid.
 */
export function SkeletonCardGrid({
  count = 10,
  columns = "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]",
  action = false,
}: {
  count?: number;
  columns?: string;
  action?: boolean;
}) {
  return (
    <ul className={`grid gap-2 sm:gap-2.5 ${columns}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="dense-card overflow-hidden p-0">
          <div className={`${PULSE} aspect-square w-full bg-panel`} />
          <div className="space-y-1.5 p-2 sm:p-2.5">
            <div className={`${PULSE} h-3 w-1/2 rounded bg-panel`} />
            <div className={`${PULSE} h-4 w-2/3 rounded bg-panel`} />
            {action ? <div className={`${PULSE} h-9 w-full rounded-md bg-panel`} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Table/list rows. `columns` is the per-row cell widths, so the placeholder
 * lines up with the real header instead of drifting under it.
 */
export function SkeletonRows({
  rows = 6,
  columns = ["w-16", "w-32", "w-20", "w-24"],
}: {
  rows?: number;
  columns?: string[];
}) {
  return (
    <ul className="divide-y divide-line" aria-hidden="true">
      {Array.from({ length: rows }, (_, r) => (
        <li key={r} className="flex items-center gap-3 px-3 py-2.5">
          {columns.map((w, c) => (
            <div key={c} className={`${PULSE} h-3 rounded bg-panel ${w}`} />
          ))}
        </li>
      ))}
    </ul>
  );
}

/**
 * Stat strip — the label/value tiles used across market and admin headers.
 *
 * `columns` must match the grid of the real strip it stands in for. A default
 * that is merely plausible defeats the point: a 4-column placeholder in front
 * of a 3-column grid reflows the moment data lands, which is the jump the
 * skeleton exists to prevent.
 */
export function SkeletonStats({
  count = 4,
  columns = "sm:grid-cols-2 lg:grid-cols-4",
  className = "",
}: {
  count?: number;
  columns?: string;
  className?: string;
}) {
  return (
    <div className={`grid gap-2 ${columns} ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-line bg-panel-strong p-3">
          <div className={`${PULSE} h-2.5 w-20 rounded bg-panel`} />
          <div className={`${PULSE} mt-2 h-5 w-24 rounded bg-panel`} />
        </div>
      ))}
    </div>
  );
}
