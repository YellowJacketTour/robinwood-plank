import { COVERAGE_STYLE, COVERAGE_LABEL, type MarketCoverage } from "@/lib/market/multichain/venue-registry";
import { coverageShortLabel, relativeAsOf } from "@/lib/market/multichain/collection-coverage";
import VenueIcon from "@/components/market/VenueIcon";

type Props = {
  venueLabel: string;
  /** Real venue-registry id (see lib/market/multichain/venue-registry.ts
   * MARKET_VENUES) -- when present, renders VenueIcon instead of the plain
   * text venue name. Optional/omittable for any caller that only has the
   * label string. */
  venueId?: string | null;
  coverage: MarketCoverage;
  /** Real ISO timestamp this collection's numbers were last observed/synced -- renders "as of Xm ago" when present. Omit rather than fabricate one. */
  asOf?: string | null;
  className?: string;
};

/**
 * Small, non-alarming inline badge -- venue mark + coverage level (same
 * exact colors/labels as app/market/multichain/known-limitations/page.tsx's
 * COVERAGE_STYLE, imported from lib/market/multichain/venue-registry.ts so
 * the two can never drift) + an optional "Xm ago" relative timestamp. This
 * is the "source chip" pattern from Issue 4 of docs/marketplank/
 * GROK-FINDINGS-biggest-issues-unified-vision-2026-08-25.md
 * ("OpenSea · live" / "Tensor · settlements only" / "UniSat · 12m ago") --
 * brought inline onto the actual ranking/detail surfaces rather than only
 * living on the dedicated known-limitations page.
 *
 * Real venue logo mark (VenueIcon) replaces the plain text venue name as of
 * 2026-08-26 -- "i dont like the opensea seaport label on the floor column
 * ... collections could have venue logo vector files for whatever different
 * marketplace theyre listed in on all chains." The venue name is still the
 * accessible name (title attribute + visually-hidden text), just no longer
 * the visible glyph.
 *
 * Deliberately renders nothing for `indexed` coverage anywhere it's used --
 * callers should not mount this component at all for a fully-indexed row
 * (see isFullyIndexedCoverage in collection-coverage.ts). This component
 * itself also no-ops on `indexed` as a second line of defense, matching
 * Grok's explicit "no doom disclaimer on every pixel" guidance: severity
 * should match real risk, not apply uniformly.
 */
export default function DataSourceChip({ venueLabel, venueId, coverage, asOf, className }: Props) {
  if (coverage === "indexed") return null;
  const asOfLabel = relativeAsOf(asOf);
  const title = `${venueLabel} · ${COVERAGE_LABEL[coverage]}${asOfLabel ? ` · as of ${asOfLabel}` : ""}`;
  return (
    <span
      className={`inline-flex min-h-5 items-center gap-1 rounded-md border px-1.5 text-[0.58rem] font-bold uppercase tracking-wide ${COVERAGE_STYLE[coverage]} ${className ?? ""}`}
      title={title}
    >
      {venueId ? (
        <VenueIcon venueId={venueId} venueLabel={venueLabel} size={12} />
      ) : (
        <span className="max-w-[6rem] truncate normal-case">{venueLabel}</span>
      )}
      <span className="sr-only">{venueLabel}</span>
      <span aria-hidden="true">·</span>
      <span>{coverageShortLabel(coverage)}</span>
      {asOfLabel && (
        <>
          <span aria-hidden="true">·</span>
          <span className="normal-case">{asOfLabel}</span>
        </>
      )}
    </span>
  );
}
