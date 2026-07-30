/**
 * No-op, kept only so app/layout.tsx (not owned here) keeps a stable import.
 *
 * This used to measure the viewport and page height on load/resize (via a
 * ResizeObserver) to stitch plank-head.webp and a stretched plank-legs.webp
 * into one seamless full-page character — that's what produced the "wall of
 * bright yellow" the owner flagged as looking strange on the live site.
 *
 * docs/mockups/landing-redesign/finalized.html — the owner-approved intent
 * for this page — never stretches plank-legs.webp at all: it's a single
 * capped plank-head.webp over a dark wash, pure CSS (see `body` in
 * app/globals.css). There is nothing left to measure or resize, so this
 * component now does nothing. Left in place rather than removing the import
 * from layout.tsx, which is outside this component's ownership.
 */
export default function PlankBackground() {
  return null;
}
