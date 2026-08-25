/**
 * Pure, framework-free helpers behind the inline "source chip" pattern from
 * Issue 4 of docs/marketplank/GROK-FINDINGS-biggest-issues-unified-
 * vision-2026-08-25.md ("Completeness visible at decision time"): a small
 * source-name + coverage-level badge next to floor/listed-count numbers,
 * plus an honest reason string for de-emphasizing a Buy CTA when the book
 * behind it isn't fully indexed. Kept separate from DataSourceChip.tsx
 * (the presentational component) so this logic is testable with plain
 * Jest/Vitest-style assertions, no React renderer required.
 */
import {
  primaryVenueForCollection,
  COVERAGE_SHORT_LABEL,
  type MarketCoverage,
  type MarketVenue,
} from "@/lib/market/multichain/venue-registry";

export type CollectionCoverageInfo = {
  venueId: string;
  venueLabel: string;
  coverage: MarketCoverage;
};

/**
 * Resolves the one venue whose coverage best describes a collection's
 * displayed numbers -- see primaryVenueForCollection's own header for the
 * exact-match-then-worst-case resolution order. Returns null only when this
 * chain has no registered venue at all (nothing honest to report).
 */
export function resolveCollectionCoverage(
  chainSlug: string,
  candidateId?: string | null
): CollectionCoverageInfo | null {
  const venue = primaryVenueForCollection(chainSlug, candidateId);
  if (!venue) return null;
  return { venueId: venue.id, venueLabel: venue.label, coverage: venue.coverage };
}

/** True only for coverage that is genuinely complete -- the one level where the chip should render nothing at all (see Grok's own "no doom disclaimer on every pixel" note: severity matches real risk). */
export function isFullyIndexedCoverage(coverage: MarketCoverage | null | undefined): boolean {
  return coverage === "indexed";
}

/** Coverage levels where a trade CTA on top of this collection's book should be visually de-emphasized (secondary style + a one-line honest reason) rather than presented as a normal, fully-trustworthy primary action. Never used to disable/block the action -- see BuyConfirm.tsx's own coverageNotice prop. */
export function isCoverageCtaDegraded(coverage: MarketCoverage | null | undefined): boolean {
  return coverage === "partial" || coverage === "planned" || coverage === "unavailable";
}

/** The exact one-line reason shown under a de-emphasized Buy CTA -- honest about WHY, not a generic warning. */
export function coverageCtaReason(info: CollectionCoverageInfo): string {
  if (info.coverage === "unavailable") return `${info.venueLabel}'s book isn't reachable on this deployment -- based on unavailable book data.`;
  if (info.coverage === "planned") return `${info.venueLabel} coverage isn't built yet -- based on incomplete book data.`;
  return `Based on partial book data (${info.venueLabel}).`;
}

/** Real "Xm/Xh/Xd ago" relative-time label for an ISO timestamp -- shared rounding rule with GlobalMarketHub.tsx's own syncFreshness so the two never silently drift into different wording for the same underlying age. Null input (no real timestamp) returns null, never a fabricated "just now". */
export function relativeAsOf(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const ageMs = now - ts;
  if (ageMs < 0) return "just now";
  const ageMin = ageMs / 60_000;
  if (ageMin < 1) return "just now";
  if (ageMin < 60) return `${Math.round(ageMin)}m ago`;
  const ageHours = ageMin / 60;
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  const ageDays = ageHours / 24;
  return `${Math.round(ageDays)}d ago`;
}

export function coverageShortLabel(coverage: MarketCoverage): string {
  return COVERAGE_SHORT_LABEL[coverage];
}

export type { MarketCoverage, MarketVenue };
