import { COVERAGE_LABEL, type MarketCoverage } from "@/lib/market/multichain/venue-registry";
import { relativeAsOf } from "@/lib/market/multichain/collection-coverage";
import VenueIcon from "@/components/market/VenueIcon";

type Props = {
  venueLabel: string;
  /** Real venue-registry id (see lib/market/multichain/venue-registry.ts
   * MARKET_VENUES) -- when present, renders VenueIcon instead of the plain
   * text venue name. Optional/omittable for any caller that only has the
   * label string, though every real call site has one. */
  venueId?: string | null;
  coverage: MarketCoverage;
  /** Real ISO timestamp this collection's numbers were last observed/synced -- renders "as of Xm ago" when present. Omit rather than fabricate one. */
  asOf?: string | null;
  className?: string;
};

/**
 * Isolated venue mark -- just the logo, no text pill. Real feedback,
 * 2026-08-26: "why does it say multi venue? we dont want that text bubble.
 * just isolated marketplace logos of any venues and a plank for marketplank
 * native listings." Replaces the earlier bordered/background chip (venue
 * name + "multi-venue"/"live" text + relative timestamp) with a bare
 * VenueIcon -- venue name, coverage level, and as-of time all move to the
 * title tooltip + sr-only text so nothing honest gets silently dropped,
 * they just aren't painted as visible text anymore.
 *
 * Still renders nothing for `indexed` coverage (see isFullyIndexedCoverage
 * in collection-coverage.ts) -- an isolated mark for the venue actually
 * backing a fully-indexed row is handled by the venue icon already shown
 * elsewhere on that row, not duplicated here.
 */
export default function DataSourceChip({ venueLabel, venueId, coverage, asOf, className }: Props) {
  if (coverage === "indexed") return null;
  if (!venueId) return null;
  const asOfLabel = relativeAsOf(asOf);
  const title = `${venueLabel} · ${COVERAGE_LABEL[coverage]}${asOfLabel ? ` · as of ${asOfLabel}` : ""}`;
  return (
    <span className={`inline-flex shrink-0 items-center ${className ?? ""}`} title={title}>
      <VenueIcon venueId={venueId} venueLabel={venueLabel} size={14} />
      <span className="sr-only">{title}</span>
    </span>
  );
}
