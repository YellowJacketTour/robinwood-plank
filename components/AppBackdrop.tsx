/**
 * Quiet warm-wood backdrop for dense app pages (Trade, Market, Gallery).
 *
 * PlankBackground.tsx renders the giant plank-head/plank-legs character as
 * the homepage's body background — that's an intentional brand statement and
 * stays untouched. On denser app pages the same character shows through the
 * gaps between panels at enormous scale (the odd yellow blobs/dark shapes),
 * because those pages never had their own background treatment layered on
 * top of it.
 *
 * This is that layer. It reuses `.site-footer-surface` (app/globals.css) —
 * the exact barely-there texture already established on the footer (solid
 * wood base, a soft directional wash, and the shared plank-grain lines) —
 * instead of inventing a second background language for app pages.
 *
 * `fixed inset-0 -z-10` keeps it pinned to the viewport (so it stays behind
 * every scroll position on a tall page, not just the top) and beneath all
 * normal in-flow content and any explicitly z-indexed overlay (nav, modals,
 * the splash preloader). It is static — no JS, no resize listeners — so it
 * can't repaint on scroll and can't race PlankBackground's ResizeObserver;
 * the two layers simply never touch the same properties.
 */
export default function AppBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="site-footer-surface pointer-events-none fixed inset-0 -z-10"
    />
  );
}
